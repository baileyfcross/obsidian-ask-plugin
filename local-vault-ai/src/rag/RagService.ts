import {
  OllamaChatOptions,
  OllamaClient,
} from "../ollama/OllamaClient";
import {
  ModelRuntimeManager,
} from "../ollama/ModelRuntimeManager";
import {
  KnowledgeIndex,
} from "../search/KnowledgeIndex";
import {
  LocalVaultAISettings,
} from "../settings/Settings";
import {
  ConversationMessage,
  RagAnswer,
} from "../types";

export type RagStreamStage =
  | "retrieving"
  | "thinking"
  | "answering";

export interface RagStreamCallbacks {
  onStage?: (
    stage: RagStreamStage,
  ) => void;

  onThinking?: (
    accumulated: string,
  ) => void;

  onAnswer?: (
    accumulated: string,
  ) => void;
}

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
    return await this.askStreaming(
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
    if (!this.index.isReady()) {
      throw new Error(
        "The knowledge index is not ready. Rebuild the index first.",
      );
    }

    this.ollama.setBaseUrl(
      this.settings.ollamaUrl,
    );

    /*
     * The lease spans retrieval and the complete
     * streamed generation. A queued model unload
     * cannot interrupt either part of this job.
     */
    const lease =
      this.modelRuntime.acquireJob({
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

      const retrievalQuery =
        this.makeRetrievalQuery(
          question,
          history,
        );

      const embeddings =
        await this.ollama.embed(
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

      const sources =
        await this.index.hybridSearch(
          retrievalQuery,
          queryVector,
          {
            limit:
              this.settings.topK,
            textWeight:
              this.settings
                .hybridTextWeight,
            vectorWeight:
              this.settings
                .hybridVectorWeight,
            similarity:
              this.settings
                .minVectorSimilarity,
          },
        );

      if (
        this.settings.vaultOnly &&
        sources.length === 0
      ) {
        const answer =
          "I couldn't find enough information in your indexed vault to answer that question.";

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
        sources
          .map(
            (
              source,
              index,
            ) =>
              [
                `[SOURCE ${index + 1}]`,
                `File: ${source.filePath}`,
                `Section: ${source.heading}`,
                `Tags: ${
                  source.tags.join(
                    ", ",
                  ) ||
                  "(none)"
                }`,
                "",
                source.content,
              ].join("\n"),
          )
          .join(
            "\n\n------------------------------\n\n",
          );

      const systemPrompt =
        this.makeSystemPrompt();

      const recentHistory =
        history
          .slice(-6)
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
                role: "system",
                content:
                  systemPrompt,
              },
              ...recentHistory,
              {
                role: "user",
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

  private makeChatOptions():
    OllamaChatOptions {
    const keepAlive =
      this.settings
        .chatKeepAlive
        .trim();

    return {
      think:
        this.settings
          .chatReasoningEffort,

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

    return [
      ...recentUserMessages,
      question,
    ].join("\n");
  }

  private makeSystemPrompt():
    string {
    if (
      this.settings.vaultOnly
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
        "- Prefer the most directly relevant sources.",
        "- Never invent a source, note, heading, or citation.",
        "- For simple factual questions, answer directly and concisely.",
        "- Do not perform unnecessary extended analysis when the answer is straightforward.",
      ].join("\n");
    }

    return [
      "You are Local Vault AI, an assistant that can use both the user's Obsidian vault and your general knowledge.",
      "",
      "Rules:",
      "- Use the supplied vault sources whenever they are relevant.",
      "- Cite vault-derived factual claims with [1], [2], etc.",
      "- Citation numbers correspond to SOURCE numbers in the current prompt.",
      "- If you add information that is not present in the vault, clearly identify it as general model knowledge.",
      "- Never invent a vault source, note, heading, or citation.",
      "- For simple factual questions, answer directly and concisely.",
      "- Do not perform unnecessary extended analysis when the answer is straightforward.",
    ].join("\n");
  }
}
