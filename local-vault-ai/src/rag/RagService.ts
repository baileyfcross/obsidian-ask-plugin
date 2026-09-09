import {
  OllamaChatOptions,
  OllamaClient,
} from "../ollama/OllamaClient";
import {
  ModelRuntimeManager,
} from "../ollama/ModelRuntimeManager";
import {
  KnowledgeIndex,
  ResolvedSource,
} from "../search/KnowledgeIndex";
import {
  LocalVaultAISettings,
} from "../settings/Settings";
import {
  ConversationMessage,
  RagAnswer,
  RetrievedChunk,
} from "../types";

export type RagStreamStage =
  | "retrieving"
  | "thinking"
  | "answering";

export type RagRetrievalMode =
  | "section"
  | "source"
  | "hybrid";

export interface RagRetrievalInfo {
  mode:
    RagRetrievalMode;

  sourceFile?: string;
  section?: string;

  chunkCount: number;
  contextCharacters: number;
}

export interface RagStreamCallbacks {
  onStage?: (
    stage: RagStreamStage,
  ) => void;

  onRetrievalInfo?: (
    info:
      RagRetrievalInfo,
  ) => void;

  onThinking?: (
    accumulated: string,
  ) => void;

  onAnswer?: (
    accumulated: string,
  ) => void;
}

const SECTION_CONTEXT_CHUNKS = 4;
const SOURCE_CONTEXT_CHUNKS = 6;

/*
 * This is intentionally a character budget rather
 * than a token estimate. It is deterministic, cheap,
 * and prevents a large PDF retrieval from sending
 * tens of thousands of characters to an 8B model.
 */
const MAX_CONTEXT_CHARACTERS =
  16000;

export class RagService {
  constructor(
    private readonly ollama:
      OllamaClient,
    private readonly index:
      KnowledgeIndex,
    private readonly settings:
      LocalVaultAISettings,
    private readonly modelRuntime:
      ModelRuntimeManager,
  ) {}

  async ask(
    question: string,
    history:
      ConversationMessage[],
  ): Promise<RagAnswer> {
    return this.askStreaming(
      question,
      history,
    );
  }

  async askStreaming(
    question: string,
    history:
      ConversationMessage[],
    callbacks?:
      RagStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<RagAnswer> {
    if (
      !this.index.isReady()
    ) {
      throw new Error(
        "The knowledge index is not ready. Rebuild the index first.",
      );
    }

    this.ollama.setBaseUrl(
      this.settings
        .ollamaUrl,
    );

    const lease =
      this.modelRuntime
        .acquireJob({
          kind: "chat",
          label:
            "Answering vault question",
          models: [
            this.settings
              .embeddingModel,
            this.settings
              .chatModel,
          ],
        });

    try {
      callbacks?.onStage?.(
        "retrieving",
      );

      const requestedSource =
        await this.index
          .resolveSourceReference(
            question,
          );

      const requestedSection =
        this.extractSectionIdentifier(
          question,
        );

      let retrievalMode:
        RagRetrievalMode =
        requestedSource
          ? "source"
          : "hybrid";

      let retrievedSources:
        RetrievedChunk[] = [];

      /*
       * Fast path:
       *
       * If both a source and an explicit numbered
       * section are known, try a direct lexical
       * section lookup first.
       *
       * No embedding request is required here.
       */
      if (
        requestedSource &&
        requestedSection
      ) {
        const sectionSources =
          await this.index
            .searchSectionInSource(
              requestedSource
                .filePath,
              requestedSection,
              SECTION_CONTEXT_CHUNKS,
            );

        if (
          sectionSources.length >
          0
        ) {
          retrievedSources =
            sectionSources;

          retrievalMode =
            "section";
        }
      }

      /*
       * Semantic fallback:
       *
       * - no explicit section,
       * - direct section lookup found nothing, or
       * - no named source was resolved.
       */
      if (
        retrievedSources.length ===
        0
      ) {
        const retrievalQuery =
          this.makeRetrievalQuery(
            question,
            history,
            requestedSource,
            requestedSection,
          );

        const embeddings =
          await this.ollama
            .embed(
              this.settings
                .embeddingModel,
              [retrievalQuery],
            );

        const queryVector =
          embeddings[0];

        if (!queryVector) {
          throw new Error(
            "Could not create a query embedding.",
          );
        }

        retrievedSources =
          await this.index
            .hybridSearch(
              retrievalQuery,
              queryVector,
              {
                /*
                 * Previously named PDFs were expanded
                 * to at least 12 chunks. That can make
                 * qwen3:8b spend a long time evaluating
                 * the prompt before any streamed token
                 * is available.
                 */
                limit:
                  requestedSource
                    ? SOURCE_CONTEXT_CHUNKS
                    : this.settings
                        .topK,

                textWeight:
                  this.settings
                    .hybridTextWeight,

                vectorWeight:
                  this.settings
                    .hybridVectorWeight,

                similarity:
                  this.settings
                    .minVectorSimilarity,

                sourcePath:
                  requestedSource
                    ?.filePath,
              },
            );
      }

      const sources =
        this.applyContextBudget(
          retrievedSources,
          requestedSection,
        );

      const contextCharacters =
        sources.reduce(
          (
            total,
            source,
          ) =>
            total +
            source.content
              .length,
          0,
        );

      callbacks
        ?.onRetrievalInfo?.({
          mode:
            retrievalMode,

          sourceFile:
            requestedSource
              ?.fileName,

          section:
            requestedSection ??
            undefined,

          chunkCount:
            sources.length,

          contextCharacters,
        });

      if (
        this.settings
          .vaultOnly &&
        sources.length === 0
      ) {
        const answer =
          requestedSource
            ? requestedSection
              ? `I found the requested source "${requestedSource.fileName}", ` +
                `but I could not retrieve indexed content for section ${requestedSection}.`
              : `I found the requested source "${requestedSource.fileName}", ` +
                "but I could not retrieve a relevant indexed section for that question."
            : "I couldn't find enough information in your indexed vault to answer that question.";

        callbacks?.onStage?.(
          "answering",
        );

        callbacks?.onAnswer?.(
          answer,
        );

        return {
          answer,
          sources: [],
        };
      }

      const sourceContext =
        this.buildSourceContext(
          sources,
        );

      const systemPrompt =
        this.makeSystemPrompt(
          requestedSource,
          requestedSection,
        );

      /*
       * Keep a small amount of conversation context.
       * The source material should dominate the
       * context window for document questions.
       */
      const recentHistory =
        history
          .slice(-4)
          .map(
            (message) => ({
              role:
                message.role,
              content:
                message.content,
            }),
          );

      const userPrompt = [
        "QUESTION",
        "",
        question,
        "",
        "REQUESTED SOURCE",
        "",
        requestedSource
          ? [
              `File: ${requestedSource.filePath}`,
              `Title: ${requestedSource.title}`,
              `Type: ${requestedSource.sourceType}`,
              requestedSection
                ? `Requested section: ${requestedSection}`
                : "",
              "Retrieval has been restricted to this source.",
            ]
              .filter(Boolean)
              .join("\n")
          : "(No explicit source was resolved.)",
        "",
        "VAULT SOURCES",
        "",
        sourceContext ||
          "(No vault sources were retrieved.)",
      ].join("\n");

      let thinkingStarted =
        false;

      let answerStarted =
        false;

      const response =
        await this.ollama
          .chatStreamWithThinking(
            this.settings
              .chatModel,
            [
              {
                role:
                  "system",
                content:
                  systemPrompt,
              },

              ...recentHistory,

              {
                role:
                  "user",
                content:
                  userPrompt,
              },
            ],
            this.makeChatOptions(),
            {
              onThinking:
                (
                  _delta,
                  accumulated,
                ) => {
                  if (
                    !thinkingStarted
                  ) {
                    thinkingStarted =
                      true;

                    callbacks
                      ?.onStage?.(
                        "thinking",
                      );
                  }

                  callbacks
                    ?.onThinking?.(
                      accumulated,
                    );
                },

              onContent:
                (
                  _delta,
                  accumulated,
                ) => {
                  if (
                    !answerStarted
                  ) {
                    answerStarted =
                      true;

                    callbacks
                      ?.onStage?.(
                        "answering",
                      );
                  }

                  callbacks
                    ?.onAnswer?.(
                      accumulated,
                    );
                },
            },
            signal,
          );

      return {
        answer:
          response.content,

        thinking:
          response.thinking,

        sources,
      };
    } finally {
      await lease.release();
    }
  }

  private applyContextBudget(
    sources:
      RetrievedChunk[],
    requestedSection:
      string | null,
  ): RetrievedChunk[] {
    const maximumChunks =
      requestedSection
        ? SECTION_CONTEXT_CHUNKS
        : SOURCE_CONTEXT_CHUNKS;

    const selected:
      RetrievedChunk[] = [];

    let usedCharacters = 0;

    for (
      const source of
      sources
    ) {
      if (
        selected.length >=
        maximumChunks
      ) {
        break;
      }

      const length =
        source.content.length;

      if (
        selected.length > 0 &&
        usedCharacters +
          length >
          MAX_CONTEXT_CHARACTERS
      ) {
        break;
      }

      /*
       * Always allow the top result, even if one
       * unusually large chunk is slightly above the
       * configured budget.
       */
      selected.push(
        source,
      );

      usedCharacters +=
        length;
    }

    return selected;
  }

  private extractSectionIdentifier(
    question: string,
  ): string | null {
    /*
     * Prioritize explicit phrases so a filename
     * version such as "2.3.2" is NOT accidentally
     * interpreted as the requested textbook section.
     *
     * Examples:
     *   section 1.5
     *   sec. 1.5
     *   § 1.5
     */
    const explicit =
      question.match(
        /\b(?:section|sec\.?)\s+(\d+(?:\.\d+){1,4})\b/i,
      ) ??
      question.match(
        /§\s*(\d+(?:\.\d+){1,4})\b/i,
      );

    return (
      explicit?.[1] ??
      null
    );
  }

  private buildSourceContext(
    sources:
      RetrievedChunk[],
  ): string {
    return sources
      .map(
        (
          source,
          index,
        ) => {
          const lines = [
            `[SOURCE ${index + 1}]`,
            `File: ${source.filePath}`,
            `Type: ${source.sourceType}`,
            `Title: ${source.title}`,
            `Section: ${source.heading}`,
          ];

          if (
            source.sourceType ===
              "pdf" &&
            source.pageStart > 0
          ) {
            lines.push(
              source.pageStart ===
                source.pageEnd
                ? `PDF page: ${source.pageStart}`
                : `PDF pages: ${source.pageStart}-${source.pageEnd}`,
            );
          }

          lines.push(
            `Tags: ${
              source.tags.join(
                ", ",
              ) ||
              "(none)"
            }`,
            "",
            source.content,
          );

          return lines.join(
            "\n",
          );
        },
      )
      .join(
        "\n\n------------------------------\n\n",
      );
  }

  private makeChatOptions():
    OllamaChatOptions {
    const keepAlive =
      this.settings
        .chatKeepAlive
        .trim();

    const model =
      this.settings
        .chatModel
        .toLowerCase();

    /*
     * Ollama's Qwen3 thinking control is boolean.
     * GPT-OSS specifically expects low/medium/high.
     *
     * The previous shared setting passed "low" to
     * qwen3:8b because it originated as a GPT-OSS
     * setting. Use the correct model-specific form.
     */
    const think:
      OllamaChatOptions[
        "think"
      ] =
      model.includes(
        "gpt-oss",
      )
        ? this.settings
            .chatReasoningEffort
        : model.includes(
              "qwen3",
            )
          ? true
          : this.settings
              .chatReasoningEffort;

    return {
      think,

      keepAlive:
        keepAlive.length > 0
          ? keepAlive
          : undefined,
    };
  }

  private makeRetrievalQuery(
    question: string,
    history:
      ConversationMessage[],
    source:
      ResolvedSource | null,
    section:
      string | null,
  ): string {
    const recentUserMessages =
      history
        .filter(
          (message) =>
            message.role ===
            "user",
        )
        .slice(-2)
        .map(
          (message) =>
            message.content,
        );

    const parts = [
      ...recentUserMessages,
      question,
    ];

    if (source) {
      parts.push(
        `Requested file: ${source.fileName}`,
        `Requested title: ${source.title}`,
        `Requested path: ${source.filePath}`,
      );
    }

    if (section) {
      parts.push(
        `Requested section: ${section}`,
        `Section ${section}`,
      );
    }

    return parts.join(
      "\n",
    );
  }

  private makeSystemPrompt(
    source:
      ResolvedSource | null,
    section:
      string | null,
  ): string {
    const sourceRules:
      string[] = [];

    if (source) {
      sourceRules.push(
        `- The retrieval layer resolved the user's requested source to "${source.filePath}".`,
        "- The supplied source chunks are intentionally restricted to that source.",
        "- Do not claim that the named file does not exist when these source chunks are present.",
      );
    }

    if (section) {
      sourceRules.push(
        `- The user explicitly requested section ${section}. Focus the answer on that section.`,
        "- Do not summarize unrelated chapters or sections unless needed to explain the requested material.",
      );
    }

    if (
      this.settings
        .vaultOnly
    ) {
      return [
        "You are Local Vault AI, an assistant for the user's Obsidian knowledge vault.",
        "",
        "Rules:",
        "- Answer using only the supplied vault sources.",
        "- You may reason about the supplied material, but do not add outside factual knowledge.",
        "- If the sources are insufficient, say that the indexed vault does not contain enough information.",
        "- Cite factual claims from the vault with [1], [2], etc.",
        "- Citation numbers correspond to SOURCE numbers in the current prompt.",
        "- For PDF sources, use the supplied page information when it is helpful.",
        "- Prefer the most directly relevant sources.",
        "- Never invent a source, note, heading, page, or citation.",
        "- For simple factual questions, answer directly and concisely.",
        ...sourceRules,
      ].join("\n");
    }

    return [
      "You are Local Vault AI, an assistant that can use both the user's Obsidian vault and your general knowledge.",
      "",
      "Rules:",
      "- Use the supplied vault sources whenever they are relevant.",
      "- Cite vault-derived factual claims with [1], [2], etc.",
      "- Citation numbers correspond to SOURCE numbers in the current prompt.",
      "- For PDF sources, use the supplied page information when it is helpful.",
      "- If you add information that is not present in the vault, clearly identify it as general model knowledge.",
      "- Never invent a vault source, note, heading, page, or citation.",
      "- For simple factual questions, answer directly and concisely.",
      ...sourceRules,
    ].join("\n");
  }
}
