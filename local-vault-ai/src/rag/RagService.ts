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
  RagStageTimings,
  RetrievedChunk,
} from "../types";
import {
  extractRequestedSourcePhrase,
} from "../retrieval/SourceResolver";

export type RagStreamStage =
  | "retrieving"
  | "model"
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

export type RagGenerationMode =
  | "chat"
  | "lecture";

interface RagGenerationProfile {
  mode:
    RagGenerationMode;

  model:
    string;

  label:
    string;
}

interface SectionIntegrityResult {
  ok:
    boolean;

  expectedSection:
    string;

  unexpectedSections:
    string[];

  unexpectedSources:
    string[];

  invalidChunkCount:
    number;
}

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

  generationMode?:
    RagGenerationMode;

  generationModel?:
    string;
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

  /*
   * Gives the chat UI the exact chunks selected for the
   * current request. This allows a user-cancelled partial
   * response to retain its citations.
   */
  onSources?: (
    sources:
      RetrievedChunk[],
  ) => void;

  onTimings?: (
    timings:
      RagStageTimings,
  ) => void;

  onThinking?: (
    accumulated: string,
  ) => void;

  onAnswer?: (
    accumulated: string,
  ) => void;
}

const SECTION_CONTEXT_CHUNKS_CHAT =
  6;

const SECTION_CONTEXT_CHUNKS_LECTURE =
  12;

const SOURCE_CONTEXT_CHUNKS_CHAT =
  6;

const SOURCE_CONTEXT_CHUNKS_LECTURE =
  10;

const MAX_CONTEXT_CHARACTERS_CHAT =
  18000;

const MAX_CONTEXT_CHARACTERS_LECTURE =
  30000;

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
    retrievalStartedAt =
      performance.now(),
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

    /*
     * Generation routing is independent from retrieval.
     *
     * Normal vault questions use chatModel.
     * Lecture/slide/presentation requests use
     * lectureModel.
     */
    const generationProfile =
      this.resolveGenerationProfile(
        question,
      );

    const leaseModels =
      [
        generationProfile
          .model,
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
            generationProfile
              .label,

          models:
            leaseModels,
        });

    try {
      this.throwIfAborted(
        signal,
      );

      const retrievalStartedAt =
        performance.now();

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

      this.throwIfAborted(
        signal,
      );

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

        this.throwIfAborted(
          signal,
        );

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

        this.throwIfAborted(
          signal,
        );

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

        this.throwIfAborted(
          signal,
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

          this.throwIfAborted(
            signal,
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

          this.throwIfAborted(
            signal,
          );

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

            this.sectionContextChunks(
              generationProfile,
            ),

            this.contextCharacterBudget(
              generationProfile,
            ),
          );

        const integrity =
          this.validateSectionIntegrity(
            requestedSource,
            requestedSection,
            sources,
          );

        if (
          !integrity.ok
        ) {
          return this.blockSectionIntegrityFailure(
            requestedSource,
            requestedSection,
            integrity,
            generationProfile,
            callbacks,
            signal,
          );
        }

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

            generationProfile,
          },
        );

        return await this
          .generateAnswer(
            question,
            history,
            requestedSource,
            requestedSection,
            sources,
            generationProfile,
            callbacks,
            signal,
            retrievalStartedAt,
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

      this.throwIfAborted(
        signal,
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
                  ? this.sourceContextChunks(
                      generationProfile,
                    )
                  : Math.max(
                      this.settings
                        .topK,
                      generationProfile
                        .mode ===
                        "lecture"
                        ? SOURCE_CONTEXT_CHUNKS_LECTURE
                        : this.settings
                            .topK,
                    ),

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

      this.throwIfAborted(
        signal,
      );

      const sources =
        this.applyContextBudget(
          retrieved,

          requestedSource
            ? this.sourceContextChunks(
                generationProfile,
              )
            : generationProfile
                .mode ===
                "lecture"
              ? Math.max(
                  this.settings
                    .topK,
                  SOURCE_CONTEXT_CHUNKS_LECTURE,
                )
              : this.settings
                  .topK,

          this.contextCharacterBudget(
            generationProfile,
          ),
        );

      if (
        requestedSection
      ) {
        if (
          !requestedSource
        ) {
          return this.blockSectionWithoutSource(
            requestedSection,
            generationProfile,
            callbacks,
            signal,
          );
        }

        const integrity =
          this.validateSectionIntegrity(
            requestedSource,
            requestedSection,
            sources,
          );

        if (
          !integrity.ok
        ) {
          return this.blockSectionIntegrityFailure(
            requestedSource,
            requestedSection,
            integrity,
            generationProfile,
            callbacks,
            signal,
          );
        }
      }

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

          generationProfile,
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

        this.throwIfAborted(
          signal,
        );

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

      this.throwIfAborted(
        signal,
      );

      return await this
        .generateAnswer(
          question,
          history,
          requestedSource,
          requestedSection,
          sources,
          generationProfile,
          callbacks,
          signal,
          retrievalStartedAt,
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
    generationProfile:
      RagGenerationProfile,
    callbacks?:
      RagStreamCallbacks,
    signal?: AbortSignal,
    retrievalStartedAt =
      performance.now(),
  ): Promise<RagAnswer> {
    this.throwIfAborted(
      signal,
    );

    /*
     * FINAL GENERATION FIREWALL.
     *
     * Every explicit-section request is validated again
     * immediately before source context is constructed.
     *
     * Even if a future code path accidentally bypasses
     * the exact-section branch above, unrelated chunks
     * still cannot be sent to Ollama.
     */
    if (
      requestedSection
    ) {
      if (
        !requestedSource
      ) {
        return this.blockSectionWithoutSource(
          requestedSection,
          generationProfile,
          callbacks,
          signal,
        );
      }

      const integrity =
        this.validateSectionIntegrity(
          requestedSource,
          requestedSection,
          sources,
        );

      if (
        !integrity.ok
      ) {
        return this.blockSectionIntegrityFailure(
          requestedSource,
          requestedSection,
          integrity,
          generationProfile,
          callbacks,
          signal,
        );
      }
    }

    const timings:
      RagStageTimings = {
      retrievalMs:
        Math.max(
          0,
          performance.now() -
            retrievalStartedAt,
        ),
    };

    callbacks?.onTimings?.({
      ...timings,
    });

    callbacks?.onStage?.(
      "model",
    );

    const sourceContext =
      this.buildSourceContext(
        sources,
      );

    const systemPrompt =
      this.makeSystemPrompt(
        requestedSource,
        requestedSection,
        generationProfile,
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
      "GENERATION ROUTE",
      "",
      `Mode: ${generationProfile.mode}`,
      `Model: ${generationProfile.model}`,
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

    let reasoningStartedAt:
      number | null =
      null;

    let answeringStartedAt:
      number | null =
      null;

    /*
     * GENERATION ALWAYS USES OLLAMA.
     *
     * The embedding toggle above affects only query
     * vector creation. The final answer, reasoning,
     * and streamed text always go through the configured
     * Ollama server.
     *
     * The selected model depends on generation intent:
     *
     *   chat    -> settings.chatModel
     *   lecture -> settings.lectureModel
     */
    const response =
      await this.ollama
        .chatStreamWithThinking(
          generationProfile
            .model,

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

          this.makeChatOptions(
            generationProfile,
          ),

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

                  reasoningStartedAt =
                    performance.now();

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

                  const now =
                    performance.now();

                  answeringStartedAt =
                    now;

                  timings.reasoningMs =
                    reasoningStartedAt ===
                      null
                      ? 0
                      : Math.max(
                          0,
                          now -
                            reasoningStartedAt,
                        );

                  callbacks?.onTimings?.({
                    ...timings,
                  });

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

    const completedAt =
      performance.now();

    if (
      answeringStartedAt !==
      null
    ) {
      timings.answeringMs =
        Math.max(
          0,
          completedAt -
            answeringStartedAt,
        );
    } else if (
      reasoningStartedAt !==
      null
    ) {
      timings.reasoningMs =
        Math.max(
          0,
          completedAt -
            reasoningStartedAt,
        );
    }

    if (
      response.metrics
        ?.loadDurationMs !==
      undefined
    ) {
      timings.modelStartupMs =
        response.metrics
          .loadDurationMs;
    }

    if (
      response.metrics
        ?.promptEvalDurationMs !==
      undefined
    ) {
      timings.promptProcessingMs =
        response.metrics
          .promptEvalDurationMs;
    }

    callbacks?.onTimings?.({
      ...timings,
    });

    return {
      answer:
        response.content,

      thinking:
        response.thinking,

      sources,

      stageTimings: {
        ...timings,
      },
    };
  }

  private validateSectionIntegrity(
    requestedSource:
      ResolvedSource,

    requestedSection:
      string,

    sources:
      RetrievedChunk[],
  ): SectionIntegrityResult {
    const expectedSection =
      this.normalizeSectionIdentifier(
        requestedSection,
      );

    const unexpectedSections =
      new Set<string>();

    const unexpectedSources =
      new Set<string>();

    let invalidChunkCount =
      0;

    for (
      const source of
      sources
    ) {
      const actualSection =
        this.normalizeSectionIdentifier(
          source.sectionNumber,
        );

      const sourceMatches =
        source.filePath ===
        requestedSource.filePath;

      const sectionMatches =
        actualSection.length >
          0 &&
        actualSection ===
          expectedSection;

      if (
        sourceMatches &&
        sectionMatches
      ) {
        continue;
      }

      invalidChunkCount +=
        1;

      if (
        !sourceMatches
      ) {
        unexpectedSources.add(
          source.filePath ||
            "(missing source path)",
        );
      }

      if (
        !sectionMatches
      ) {
        unexpectedSections.add(
          source.sectionNumber
            ?.trim() ||
            "(missing section metadata)",
        );
      }
    }

    return {
      ok:
        sources.length >
          0 &&
        invalidChunkCount ===
          0,

      expectedSection,

      unexpectedSections:
        Array.from(
          unexpectedSections,
        ),

      unexpectedSources:
        Array.from(
          unexpectedSources,
        ),

      invalidChunkCount,
    };
  }

  private blockSectionIntegrityFailure(
    requestedSource:
      ResolvedSource,

    requestedSection:
      string,

    integrity:
      SectionIntegrityResult,

    generationProfile:
      RagGenerationProfile,

    callbacks?:
      RagStreamCallbacks,

    signal?:
      AbortSignal,
  ): RagAnswer {
    this.throwIfAborted(
      signal,
    );

    /*
     * Clear any citations a UI may have cached from a
     * previous retrieval callback in this request.
     */
    callbacks?.onSources?.(
      [],
    );

    const unexpectedSectionText =
      integrity
        .unexpectedSections
        .length >
        0
        ? integrity
            .unexpectedSections
            .join(
              ", ",
            )
        : "(none reported)";

    const unexpectedSourceText =
      integrity
        .unexpectedSources
        .length >
        0
        ? integrity
            .unexpectedSources
            .join(
              ", ",
            )
        : "(none reported)";

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

        section:
          requestedSection,

        chunkCount:
          0,

        contextCharacters:
          0,

        blockedReason:
          "section-integrity-failed",

        detectedSections:
          integrity
            .unexpectedSections,

        generationMode:
          generationProfile
            .mode,

        generationModel:
          generationProfile
            .model,
      });

    const answer = [
      "Retrieval integrity check failed.",
      "",
      `Requested section: ${requestedSection}`,
      `Resolved source: ${requestedSource.fileName}`,
      `Expected source path: ${requestedSource.filePath}`,
      `Invalid retrieved chunks: ${integrity.invalidChunkCount}`,
      `Unexpected retrieved sections: ${unexpectedSectionText}`,
      `Unexpected retrieved source paths: ${unexpectedSourceText}`,
      "",
      "Generation was stopped before any retrieved text was sent to the model.",
      "Local Vault AI will not substitute unrelated sections for an explicit section request.",
      "",
      "Rebuild the knowledge index if this persists. If the requested section still cannot be found after a rebuild, the PDF section parser/index metadata should be inspected.",
    ].join(
      "\n",
    );

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

  private blockSectionWithoutSource(
    requestedSection:
      string,

    generationProfile:
      RagGenerationProfile,

    callbacks?:
      RagStreamCallbacks,

    signal?:
      AbortSignal,
  ): RagAnswer {
    this.throwIfAborted(
      signal,
    );

    callbacks?.onSources?.(
      [],
    );

    callbacks
      ?.onRetrievalInfo?.({
        mode:
          "section",

        section:
          requestedSection,

        chunkCount:
          0,

        contextCharacters:
          0,

        blockedReason:
          "section-source-unresolved",

        generationMode:
          generationProfile
            .mode,

        generationModel:
          generationProfile
            .model,
      });

    const answer =
      `I detected an explicit request for section ${requestedSection}, ` +
      "but no source could be resolved for that section. " +
      "Generation was stopped rather than falling back to whole-vault retrieval.";

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

  private normalizeSectionIdentifier(
    value:
      string | null | undefined,
  ): string {
    return (
      value ??
      ""
    )
      .replace(
        /§/g,
        "",
      )
      .replace(
        /\s+/g,
        "",
      )
      .replace(
        /\.+$/,
        "",
      )
      .trim();
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

      generationProfile?:
        RagGenerationProfile;
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
      ?.onSources?.(
        data.sources,
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

        generationMode:
          data.generationProfile
            ?.mode,

        generationModel:
          data.generationProfile
            ?.model,
      });
  }

  private applyContextBudget(
    sources:
      RetrievedChunk[],
    maximumChunks:
      number,
    maximumCharacters =
      MAX_CONTEXT_CHARACTERS_CHAT,
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
          maximumCharacters
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

  private makeChatOptions(
    generationProfile:
      RagGenerationProfile,
  ): OllamaChatOptions {
    const keepAlive =
      this.settings
        .chatKeepAlive
        .trim();

    const model =
      generationProfile
        .model
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

    /*
     * Keep generation-runtime tuning separate from
     * retrieval and embedding behavior.
     *
     * Local embeddings remain local. These settings are
     * sent only to the Ollama generation request.
     */
    const numThread =
      this.settings
        .generationCpuThreads;

    const numBatch =
      this.settings
        .generationBatchSize;

    const numCtx =
      generationProfile
        .mode ===
      "lecture"
        ? this.settings
            .lectureContextSize
        : this.settings
            .chatContextSize;

    return {
      think,

      keepAlive:
        keepAlive.length > 0
          ? keepAlive
          : undefined,

      /*
       * Zero means "Auto" in plugin settings. Omitting
       * num_thread allows Ollama to use its own default.
       */
      numThread:
        numThread > 0
          ? numThread
          : undefined,

      numBatch:
        numBatch > 0
          ? numBatch
          : undefined,

      numCtx:
        numCtx > 0
          ? numCtx
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

  private throwIfAborted(
    signal?:
      AbortSignal,
  ): void {
    if (
      !signal?.aborted
    ) {
      return;
    }

    const error =
      new Error(
        "Request cancelled.",
      );

    error.name =
      "AbortError";

    throw error;
  }

  private makeSystemPrompt(
    source:
      ResolvedSource | null,
    section:
      string | null,
    generationProfile:
      RagGenerationProfile,
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
        "- Focus the response on that section and do not substitute unrelated pages.",
      );
    }

    if (
      generationProfile
        .mode ===
      "lecture"
    ) {
      return this
        .makeLectureSystemPrompt(
          sourceRules,
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

  private makeLectureSystemPrompt(
    sourceRules:
      string[],
  ): string {
    const groundingRules =
      this.settings
        .vaultOnly
        ? [
            "- Use only the supplied vault sources for factual course content.",
            "- You may reorganize, explain, and teach the supplied material, but do not introduce outside factual content.",
            "- If the retrieved material is insufficient for a complete requested lecture, say what is missing rather than inventing material.",
          ]
        : [
            "- Ground the lecture primarily in the supplied vault sources.",
            "- If you add general model knowledge that is not present in the vault, clearly label it as supplemental material.",
          ];

    return [
      "You are Local Vault AI's lecture-generation assistant.",
      "",
      "Your job is to turn the retrieved source material into clear college-level teaching slides in plain text.",
      "",
      "Lecture output rules:",
      "- Produce text only. Do not create or claim to create a PowerPoint file.",
      "- When the user asks for a slide-by-slide response, output only the slides with no introductory or closing commentary outside the slide sequence.",
      "- Format each slide as: `## Slide N — <descriptive title>`.",
      "- Under each slide title, use concise bullet points suitable for projection in a classroom.",
      "- Give each slide enough substance to teach from; do not return one-line placeholder slides.",
      "- Preserve the scope requested by the user. If the user asks for one numbered section, keep the lecture focused on that section.",
      "- Include clear explanations of important terms and concepts.",
      "- Include concrete examples when they are supported by, or can be directly derived from, the supplied source material.",
      "- Include short in-class checks, examples, or exercises when they materially improve the lesson and remain grounded in the source.",
      "- Do not repeat the same point across several slides unless repetition is pedagogically useful.",
      "- Cite vault-derived material with [1], [2], etc. Citation numbers correspond to SOURCE numbers in the current prompt.",
      "- Never invent a source, section, page, heading, quotation, or citation.",
      "- For PDF material, use the supplied section and page metadata when useful.",
      ...groundingRules,
      ...sourceRules,
    ].join("\n");
  }

  private resolveGenerationProfile(
    question:
      string,
  ): RagGenerationProfile {
    const lectureRequested =
      this.isLectureGenerationRequest(
        question,
      );

    if (
      lectureRequested
    ) {
      const configured =
        this.settings
          .lectureModel
          .trim();

      const model =
        configured.length > 0
          ? configured
          : this.settings
              .chatModel;

      return {
        mode:
          "lecture",

        model,

        label:
          "Generating lecture from vault sources",
      };
    }

    return {
      mode:
        "chat",

      model:
        this.settings
          .chatModel,

      label:
        "Answering vault question",
    };
  }

  private isLectureGenerationRequest(
    question:
      string,
  ): boolean {
    const normalized =
      question
        .toLowerCase()
        .replace(
          /\s+/g,
          " ",
        )
        .trim();

    const patterns:
      RegExp[] = [
      /\bslide[\s-]*by[\s-]*slide\b/i,

      /\b(?:create|make|build|generate|write|prepare|give|produce)\b.{0,80}\b(?:lecture|lesson|presentation|slides?|slide\s+deck)\b/i,

      /\b(?:lecture|lesson|presentation|slides?|slide\s+deck)\b.{0,50}\b(?:for|from|on|about|using)\b/i,

      /\b(?:lecture\s+slides?|class\s+slides?|teaching\s+slides?)\b/i,
    ];

    return patterns.some(
      (pattern) =>
        pattern.test(
          normalized,
        ),
    );
  }

  private sectionContextChunks(
    generationProfile:
      RagGenerationProfile,
  ): number {
    return generationProfile
      .mode ===
      "lecture"
      ? SECTION_CONTEXT_CHUNKS_LECTURE
      : SECTION_CONTEXT_CHUNKS_CHAT;
  }

  private sourceContextChunks(
    generationProfile:
      RagGenerationProfile,
  ): number {
    return generationProfile
      .mode ===
      "lecture"
      ? SOURCE_CONTEXT_CHUNKS_LECTURE
      : SOURCE_CONTEXT_CHUNKS_CHAT;
  }

  private contextCharacterBudget(
    generationProfile:
      RagGenerationProfile,
  ): number {
    return generationProfile
      .mode ===
      "lecture"
      ? MAX_CONTEXT_CHARACTERS_LECTURE
      : MAX_CONTEXT_CHARACTERS_CHAT;
  }

}
