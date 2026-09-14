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
  EmbeddingServiceRouter,
} from "../embeddings/EmbeddingServiceRouter";
import {
  ConversationMessage,
  RagAnswer,
  RetrievedChunk,
} from "../types";
import {
  extractRequestedSourcePhrase,
} from "../retrieval/SourceResolver";

export type RagStreamStage =
  | "retrieving"
  | "thinking"
  | "answering";

export type RagRetrievalMode =
  | "section"
  | "source"
  | "hybrid";

export type SourceResolutionOrigin =
  | "current-question"
  | "conversation-context"
  | "unresolved";

export interface RagRetrievalInfo {
  mode:
    RagRetrievalMode;

  sourceFile?: string;
  sourceConfidence?: number;
  sourceResolution?:
    SourceResolutionOrigin;

  section?: string;
  sectionTitle?: string;

  chunkCount: number;
  contextCharacters: number;

  blockedReason?: string;

  sourceSuggestions?: string[];

  detectedSections?: string[];
}

export interface RagStreamCallbacks {
  onStage?: (
    stage:
      RagStreamStage,
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

const SECTION_CONTEXT_CHUNKS =
  6;

const SOURCE_CONTEXT_CHUNKS =
  6;

const MAX_CONTEXT_CHARACTERS =
  18000;

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
    private readonly embeddings:
      EmbeddingServiceRouter,
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

    const leaseModels =
      [
        this.settings
          .chatModel,
      ];

    const remoteEmbeddingModel =
      this.embeddings
        .getOllamaModelName();

    if (
      remoteEmbeddingModel &&
      !leaseModels.includes(
        remoteEmbeddingModel,
      )
    ) {
      leaseModels.push(
        remoteEmbeddingModel,
      );
    }

    const lease =
      this.modelRuntime
        .acquireJob({
          kind: "chat",

          label:
            "Answering vault question",

          models:
            leaseModels,
        });

    try {
      callbacks?.onStage?.(
        "retrieving",
      );

      const requestedSection =
        this.extractSectionIdentifier(
          question,
        );

      const sourceResolution =
        await this
          .resolveRequestedSource(
            question,
            history,
          );

      const requestedSource =
        sourceResolution.source;

      /*
       * EXPLICIT SECTION REQUESTS FAIL CLOSED.
       *
       * A request such as "section 1.5" must never fall
       * through to whole-vault semantic retrieval when
       * the source cannot be identified. That was the
       * behavior that allowed unrelated C# chunks to
       * reach GPT-OSS.
       */
      if (
        requestedSection &&
        !requestedSource
      ) {
        const explicitPhrase =
          extractRequestedSourcePhrase(
            question,
          );

        const suggestions =
          explicitPhrase
            ? await this.index
                .findSourceSuggestions(
                  question,
                  3,
                )
            : [];

        const suggestionNames =
          suggestions.map(
            (source) =>
              `${source.fileName} (${source.confidence}%)`,
          );

        callbacks
          ?.onRetrievalInfo?.({
            mode:
              "section",

            sourceResolution:
              "unresolved",

            section:
              requestedSection,

            chunkCount: 0,

            contextCharacters:
              0,

            blockedReason:
              "source-unresolved",

            sourceSuggestions:
              suggestionNames,
          });

        let answer =
          explicitPhrase
            ? `I detected a request for section ${requestedSection}, but I could not confidently match ` +
              `"${explicitPhrase}" to one indexed source.`
            : `I detected a request for section ${requestedSection}, but I could not determine which indexed source you mean.`;

        if (
          suggestionNames.length >
          0
        ) {
          answer +=
            ` Possible matches: ${suggestionNames.join(", ")}.`;
        }

        answer +=
          " I did not search the rest of the vault or substitute unrelated sources.";

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

      /*
       * Source + explicit section uses exact section
       * metadata only.
       */
      if (
        requestedSource &&
        requestedSection
      ) {
        const exactSection =
          await this.index
            .searchExactSection(
              requestedSource
                .filePath,

              requestedSection,

              12,
            );

        if (
          exactSection.length ===
          0
        ) {
          const detected =
            await this.index
              .listSectionsInSource(
                requestedSource
                  .filePath,
                120,
              );

          const detectedLabels =
            detected
              .slice(
                0,
                24,
              )
              .map(
                (section) =>
                  section.title
                    ? `${section.number} ${section.title}`
                    : section.number,
              );

          callbacks
            ?.onRetrievalInfo?.({
              mode:
                "section",

              sourceFile:
                requestedSource
                  .fileName,

              sourceConfidence:
                requestedSource
                  .confidence,

              sourceResolution:
                sourceResolution
                  .origin,

              section:
                requestedSection,

              chunkCount: 0,

              contextCharacters:
                0,

              blockedReason:
                "section-not-indexed",

              detectedSections:
                detectedLabels,
            });

          let answer =
            `I resolved the requested source to "${requestedSource.fileName}", ` +
            `but section ${requestedSection} was not found in that source's indexed section metadata. ` +
            "I did not substitute unrelated pages.";

          if (
            detectedLabels.length >
            0
          ) {
            answer +=
              ` Detected section metadata includes: ${detectedLabels.join(", ")}.`;
          } else {
            answer +=
              " No numbered section metadata was detected for this source, which points to a PDF section-parsing/indexing problem.";
          }

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

        const sources =
          this.applyContextBudget(
            exactSection,

            SECTION_CONTEXT_CHUNKS,
          );

        const sectionTitle =
          sources.find(
            (source) =>
              Boolean(
                source
                  .sectionTitle,
              ),
          )?.sectionTitle;

        this.reportRetrieval(
          callbacks,
          {
            mode:
              "section",

            source:
              requestedSource,

            sourceResolution:
              sourceResolution
                .origin,

            section:
              requestedSection,

            sectionTitle,

            sources,
          },
        );

        return await this
          .generateAnswer(
            question,
            history,
            requestedSource,
            requestedSection,
            sources,
            callbacks,
            signal,
          );
      }

      /*
       * Normal semantic/hybrid path.
       */
      const retrievalQuery =
        this.makeRetrievalQuery(
          question,
          history,
          requestedSource,
          requestedSection,
        );

      const embeddings =
        await this.embeddings
          .embed(
            [retrievalQuery],
          );

      const queryVector =
        embeddings[0];

      if (!queryVector) {
        throw new Error(
          "Could not create a query embedding.",
        );
      }

      const retrieved =
        await this.index
          .hybridSearch(
            retrievalQuery,
            queryVector,
            {
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

      const sources =
        this.applyContextBudget(
          retrieved,

          requestedSource
            ? SOURCE_CONTEXT_CHUNKS
            : this.settings
                .topK,
        );

      this.reportRetrieval(
        callbacks,
        {
          mode:
            requestedSource
              ? "source"
              : "hybrid",

          source:
            requestedSource,

          sourceResolution:
            requestedSource
              ? sourceResolution
                  .origin
              : undefined,

          section:
            requestedSection ??
            undefined,

          sources,
        },
      );

      if (
        this.settings
          .vaultOnly &&
        sources.length === 0
      ) {
        const answer =
          requestedSource
            ? `I found the requested source "${requestedSource.fileName}", ` +
              "but I could not retrieve relevant indexed content for that question."
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

      return await this
        .generateAnswer(
          question,
          history,
          requestedSource,
          requestedSection,
          sources,
          callbacks,
          signal,
        );
    } finally {
      await lease.release();
    }
  }

  private async generateAnswer(
    question: string,
    history:
      ConversationMessage[],
    requestedSource:
      ResolvedSource | null,
    requestedSection:
      string | null,
    sources:
      RetrievedChunk[],
    callbacks?:
      RagStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<RagAnswer> {
    const sourceContext =
      this.buildSourceContext(
        sources,
      );

    const systemPrompt =
      this.makeSystemPrompt(
        requestedSource,
        requestedSection,
      );

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

            requestedSection
              ? "The retrieval layer performed an exact section-metadata lookup."
              : "Retrieval has been restricted to this source.",
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

    /*
     * GENERATION ALWAYS USES OLLAMA.
     *
     * The embedding toggle above affects only query
     * vector creation. The final answer, reasoning,
     * and streamed text always go through the configured
     * Ollama server using chatModel.
     */
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
                _delta: string,
                accumulated: string,
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
                _delta: string,
                accumulated: string,
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
  }

  private reportRetrieval(
    callbacks:
      RagStreamCallbacks |
      undefined,

    data: {
      mode:
        RagRetrievalMode;

      source:
        ResolvedSource | null;

      sourceResolution?:
        SourceResolutionOrigin;

      section?:
        string;

      sectionTitle?:
        string;

      sources:
        RetrievedChunk[];
    },
  ): void {
    const contextCharacters =
      data.sources.reduce(
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
          data.mode,

        sourceFile:
          data.source
            ?.fileName,

        sourceConfidence:
          data.source
            ?.confidence,

        sourceResolution:
          data.sourceResolution,

        section:
          data.section,

        sectionTitle:
          data.sectionTitle,

        chunkCount:
          data.sources.length,

        contextCharacters,
      });
  }

  private applyContextBudget(
    sources:
      RetrievedChunk[],
    maximumChunks:
      number,
  ): RetrievedChunk[] {
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
        source.content
          .length;

      if (
        selected.length > 0 &&
        usedCharacters +
          length >
          MAX_CONTEXT_CHARACTERS
      ) {
        break;
      }

      selected.push(
        source,
      );

      usedCharacters +=
        length;
    }

    return selected;
  }

  private async resolveRequestedSource(
    question: string,
    history:
      ConversationMessage[],
  ): Promise<{
    source:
      ResolvedSource | null;

    origin:
      SourceResolutionOrigin;
  }> {
    /*
     * Current question always wins.
     */
    const current =
      await this.index
        .resolveSourceReference(
          question,
        );

    if (current) {
      return {
        source:
          current,

        origin:
          "current-question",
      };
    }

    /*
     * If the current question contains an explicit
     * source phrase but it could not be resolved,
     * do NOT silently inherit some different source
     * from prior context.
     */
    const currentPhrase =
      extractRequestedSourcePhrase(
        question,
      );

    if (currentPhrase) {
      return {
        source:
          null,

        origin:
          "unresolved",
      };
    }

    /*
     * Follow-up questions such as:
     *
     *   "What about section 1.5 again?"
     *
     * may inherit a source from recent USER messages.
     * Prefer user wording over assistant citations,
     * since a prior bad retrieval may itself have
     * produced unrelated assistant sources.
     */
    const recentUserMessages =
      history
        .filter(
          (message) =>
            message.role ===
            "user",
        )
        .slice(-6)
        .reverse();

    for (
      const message of
      recentUserMessages
    ) {
      const resolved =
        await this.index
          .resolveSourceReference(
            message.content,
          );

      if (resolved) {
        return {
          source:
            resolved,

          origin:
            "conversation-context",
        };
      }
    }

    /*
     * Last-resort conversational carry-forward:
     * only use an assistant turn when its citations
     * point to exactly ONE unique file.
     */
    const recentAssistantMessages =
      history
        .filter(
          (message) =>
            message.role ===
              "assistant" &&
            Boolean(
              message.sources
                ?.length,
            ),
        )
        .slice(-4)
        .reverse();

    for (
      const message of
      recentAssistantMessages
    ) {
      const paths =
        Array.from(
          new Set(
            (
              message.sources ??
              []
            )
              .map(
                (source) =>
                  source.filePath,
              )
              .filter(Boolean),
          ),
        );

      if (
        paths.length !==
        1
      ) {
        continue;
      }

      const filePath =
        paths[0];

      if (!filePath) {
        continue;
      }

      const fileName =
        filePath
          .split("/")
          .pop() ??
        filePath;

      return {
        source: {
          filePath,
          fileName,

          title:
            fileName.replace(
              /\.(?:pdf|md)$/i,
              "",
            ),

          sourceType:
            fileName
              .toLowerCase()
              .endsWith(
                ".pdf",
              )
              ? "pdf"
              : "markdown",

          confidence:
            100,
        },

        origin:
          "conversation-context",
      };
    }

    return {
      source:
        null,

      origin:
        "unresolved",
    };
  }

  private extractSectionIdentifier(
    question: string,
  ): string | null {
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
            `Heading: ${source.heading}`,
          ];

          if (
            source.sectionNumber
          ) {
            lines.push(
              `Section number: ${source.sectionNumber}`,
            );

            if (
              source.sectionTitle
            ) {
              lines.push(
                `Section title: ${source.sectionTitle}`,
              );
            }
          }

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
        `- The user explicitly requested section ${section}.`,
        `- Every supplied chunk for this request was selected using exact section metadata for ${section}.`,
        "- Focus the answer on that section and do not substitute unrelated pages.",
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
        "- For PDF sources, use the supplied section and page information when helpful.",
        "- Prefer the most directly relevant sources.",
        "- Never invent a source, section, heading, page, or citation.",
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
      "- For PDF sources, use the supplied section and page information when helpful.",
      "- If you add information that is not present in the vault, clearly identify it as general model knowledge.",
      "- Never invent a vault source, section, heading, page, or citation.",
      "- For simple factual questions, answer directly and concisely.",
      ...sourceRules,
    ].join("\n");
  }
}
