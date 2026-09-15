import {
  App,
  DropdownComponent,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type LocalVaultAIPlugin from "../main";
import {
  ChatReasoningEffort,
} from "./Settings";
import {
  addModelRuntimeSettings,
} from "./ModelRuntimeControls";
import {
  LocalVaultAIView,
  VIEW_TYPE_LOCAL_VAULT_AI,
} from "../ui/ChatView";
import {
  OllamaModelCatalog,
  OllamaModelPurpose,
} from "../ollama/OllamaModelCatalog";

export class LocalVaultAISettingTab
  extends PluginSettingTab {
  private readonly modelCatalog:
    OllamaModelCatalog;

  constructor(
    app: App,
    private readonly localPlugin:
      LocalVaultAIPlugin,
  ) {
    super(
      app,
      localPlugin,
    );

    this.modelCatalog =
      new OllamaModelCatalog(
        localPlugin.ollama,
      );
  }

  display(): void {
    const { containerEl } =
      this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Ollama")
      .setHeading();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "Primary model server. All chat, reasoning, lecture, and other generative model requests always use this Ollama server. If local embeddings are disabled, embedding requests use this same server too. After changing the server URL, use Refresh models below to load that server's installed models.",
      )
      .addText((text) =>
        text
          .setPlaceholder(
            "http://localhost:11434",
          )
          .setValue(
            this.localPlugin
              .settings
              .ollamaUrl,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .ollamaUrl =
                  value.trim();

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(
        "Verify that Obsidian can reach the configured Ollama server.",
      )
      .addButton((button) =>
        button
          .setButtonText(
            "Test connection",
          )
          .onClick(async () => {
            button.setDisabled(
              true,
            );

            try {
              const models =
                await this.localPlugin
                  .ollama
                  .listModels();

              new Notice(
                `Connected to Ollama. ${models.length} model(s) installed.`,
              );
            } catch (error) {
              new Notice(
                error instanceof
                  Error
                  ? error.message
                  : "Could not connect to Ollama.",
              );
            } finally {
              button.setDisabled(
                false,
              );
            }
          }),
      );

    const catalogSnapshot =
      this.modelCatalog
        .getSnapshot();

    new Setting(containerEl)
      .setName(
        "Installed model catalog",
      )
      .setDesc(
        this.modelCatalogDescription(
          catalogSnapshot,
        ),
      )
      .addButton((button) =>
        button
          .setButtonText(
            catalogSnapshot
              .status ===
              "loading"
              ? "Loading…"
              : "Refresh models",
          )
          .setDisabled(
            catalogSnapshot
              .status ===
              "loading",
          )
          .onClick(async () => {
            button.setDisabled(
              true,
            );

            button.setButtonText(
              "Loading…",
            );

            try {
              const snapshot =
                await this.modelCatalog
                  .refresh();

              new Notice(
                `Loaded ${snapshot.models.length} installed Ollama model(s).`,
              );
            } catch (error) {
              new Notice(
                error instanceof
                  Error
                  ? error.message
                  : "Could not refresh Ollama models.",
              );
            } finally {
              this.display();
            }
          }),
      );

    new Setting(containerEl)
      .setName(
        "General / Vault Explorer model",
      )
      .setDesc(
        "Used for normal vault questions, synthesis, comparisons, and general knowledge.",
      )
      .addDropdown(
        (dropdown) => {
          this.configureModelDropdown(
            dropdown,
            "generation",
            this.localPlugin
              .settings
              .chatModel,
            false,
            async (value) => {
              this.localPlugin
                .settings
                .chatModel =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          );
        },
      );

    new Setting(containerEl)
      .setName(
        "General model reasoning effort",
      )
      .setDesc(
        "Controls reasoning depth for GPT-OSS vault chat. Low is faster; Medium or High can be useful for deeper synthesis.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "low",
            "Low — faster",
          )
          .addOption(
            "medium",
            "Medium",
          )
          .addOption(
            "high",
            "High — slower",
          )
          .setValue(
            this.localPlugin
              .settings
              .chatReasoningEffort,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .chatReasoningEffort =
                  value as
                    ChatReasoningEffort;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Show model reasoning",
      )
      .setDesc(
        "Shows Ollama's model-provided reasoning trace in the chat UI when the selected model returns one.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.localPlugin
              .settings
              .showModelReasoning,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .showModelReasoning =
                  value;

              await this.localPlugin
                .saveSettings();

              const leaves =
                this.app.workspace
                  .getLeavesOfType(
                    VIEW_TYPE_LOCAL_VAULT_AI,
                  );

              for (
                const leaf of
                leaves
              ) {
                if (
                  leaf.view instanceof
                  LocalVaultAIView
                ) {
                  await leaf.view
                    .refreshForSettingsChange();
                }
              }
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "General model keep-alive",
      )
      .setDesc(
        "How long Ollama keeps the general model loaded after a chat response. Runtime controls can still unload it manually.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "0",
            "Unload after each answer",
          )
          .addOption(
            "5m",
            "5 minutes",
          )
          .addOption(
            "10m",
            "10 minutes",
          )
          .addOption(
            "30m",
            "30 minutes",
          )
          .addOption(
            "1h",
            "1 hour",
          )
          .setValue(
            this.localPlugin
              .settings
              .chatKeepAlive,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .chatKeepAlive =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName("Lecture model")
      .setDesc(
        "Used only for lecture and slide generation.",
      )
      .addDropdown(
        (dropdown) => {
          this.configureModelDropdown(
            dropdown,
            "generation",
            this.localPlugin
              .settings
              .lectureModel,
            false,
            async (value) => {
              this.localPlugin
                .settings
                .lectureModel =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          );
        },
      );

    new Setting(containerEl)
      .setName(
        "Generation performance",
      )
      .setHeading();

    new Setting(containerEl)
      .setName(
        "Generation CPU threads",
      )
      .setDesc(
        "Sets Ollama num_thread for one chat or lecture request. Auto leaves thread selection to Ollama. Start near the number of physical CPU cores; on a 4-core / 8-thread CPU, test 4, then 6 and 8 and keep whichever gives the best tokens per second.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption(
            "0",
            "Auto — Ollama decides",
          )
          .addOption(
            "1",
            "1 thread",
          )
          .addOption(
            "2",
            "2 threads",
          )
          .addOption(
            "3",
            "3 threads",
          )
          .addOption(
            "4",
            "4 threads — recommended starting point",
          )
          .addOption(
            "5",
            "5 threads",
          )
          .addOption(
            "6",
            "6 threads — test SMT",
          )
          .addOption(
            "7",
            "7 threads",
          )
          .addOption(
            "8",
            "8 threads — all logical CPUs",
          )
          .setValue(
            String(
              this.localPlugin
                .settings
                .generationCpuThreads,
            ),
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .generationCpuThreads =
                  Number.parseInt(
                    value,
                    10,
                  );

              await this.localPlugin
                .saveSettings();
            },
          );
      });

    new Setting(containerEl)
      .setName(
        "Prompt batch size",
      )
      .setDesc(
        "Sets Ollama num_batch. This mainly affects prompt/context evaluation before token generation begins. Larger values can process RAG context faster but may use more memory. 256 is a conservative starting point for this server.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "64",
            "64 — lowest memory",
          )
          .addOption(
            "128",
            "128",
          )
          .addOption(
            "256",
            "256 — recommended",
          )
          .addOption(
            "512",
            "512 — higher memory",
          )
          .setValue(
            String(
              this.localPlugin
                .settings
                .generationBatchSize,
            ),
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .generationBatchSize =
                  Number.parseInt(
                    value,
                    10,
                  );

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "General chat context size",
      )
      .setDesc(
        "Sets Ollama num_ctx for normal Vault Explorer requests. A larger context window consumes more memory. 8192 is the recommended starting point for a RAM-constrained generation server.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "4096",
            "4,096 — lowest memory",
          )
          .addOption(
            "8192",
            "8,192 — recommended",
          )
          .addOption(
            "16384",
            "16,384",
          )
          .addOption(
            "32768",
            "32,768 — high memory",
          )
          .setValue(
            String(
              this.localPlugin
                .settings
                .chatContextSize,
            ),
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .chatContextSize =
                  Number.parseInt(
                    value,
                    10,
                  );

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Lecture context size",
      )
      .setDesc(
        "Sets Ollama num_ctx for lecture and slide-generation requests. Lecture retrieval can include more source chunks than normal chat, but larger values also consume more RAM. Start at 8192; raise it only if the model fits comfortably.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "4096",
            "4,096 — lowest memory",
          )
          .addOption(
            "8192",
            "8,192 — recommended",
          )
          .addOption(
            "16384",
            "16,384",
          )
          .addOption(
            "32768",
            "32,768 — high memory",
          )
          .setValue(
            String(
              this.localPlugin
                .settings
                .lectureContextSize,
            ),
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .lectureContextSize =
                  Number.parseInt(
                    value,
                    10,
                  );

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Generation memory note",
      )
      .setDesc(
        "Changing context or batch size can cause Ollama to reload a model with different runner settings. Higher CPU utilization is not automatically faster; compare actual response speed when testing 4, 6, and 8 threads.",
      );

    new Setting(containerEl)
      .setName("Embeddings")
      .setHeading();

    new Setting(containerEl)
      .setName(
        "Use local embeddings",
      )
      .setDesc(
        "Default: enabled. Only document/query embeddings run locally. Chat, reasoning, lecture generation, and all other generative model requests still go to the configured Ollama server. Local mode uses @huggingface/tokenizers plus ONNX Runtime Web directly, with no local Ollama server. The first local use downloads and caches the embedding model/runtime assets.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.localPlugin
              .settings
              .useLocalEmbeddings,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .useLocalEmbeddings =
                  value;

              await this.localPlugin
                .saveSettings();

              this.display();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Embedding model",
      )
      .setDesc(
        this.localPlugin
          .settings
          .useLocalEmbeddings
          ? "Local embeddings are enabled. This Ollama embedding-model field is preserved but not used. It becomes active if local embeddings are disabled."
          : "Ollama model used only for document/query embeddings. Chat and lecture models still use their own model settings on the same Ollama server. Changing this requires a full knowledge-index rebuild.",
      )
      .addDropdown(
        (dropdown) => {
          this.configureModelDropdown(
            dropdown,
            "embedding",
            this.localPlugin
              .settings
              .embeddingModel,
            this.localPlugin
              .settings
              .useLocalEmbeddings,
            async (value) => {
              this.localPlugin
                .settings
                .embeddingModel =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          );
        },
      );


    addModelRuntimeSettings(
      containerEl,
      this.localPlugin,
    );

    new Setting(containerEl)
      .setName("Retrieval")
      .setHeading();

    new Setting(containerEl)
      .setName("Vault only")
      .setDesc(
        "When enabled, answers must be grounded only in retrieved vault content.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.localPlugin
              .settings
              .vaultOnly,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .vaultOnly =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Retrieved chunks",
      )
      .setDesc(
        "Maximum number of chunks supplied to general chat retrieval before any source-specific context limits are applied.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            3,
            20,
            1,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .topK,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .topK =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Semantic weight",
      )
      .setDesc(
        "Balances vector similarity against exact text matching.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            0,
            1,
            0.05,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .hybridVectorWeight,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .hybridVectorWeight =
                  value;

              this.localPlugin
                .settings
                .hybridTextWeight =
                  Number(
                    (
                      1 - value
                    ).toFixed(2),
                  );

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Minimum vector similarity",
      )
      .setDesc(
        "Lower values retrieve more semantic matches.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            0,
            1,
            0.05,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .minVectorSimilarity,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .minVectorSimilarity =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName("Conversations")
      .setHeading();

    new Setting(containerEl)
      .setName(
        "Delete all conversations",
      )
      .setDesc(
        "Permanently deletes every saved Local Vault AI chat. This does not delete or rebuild the knowledge index.",
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText(
            "Delete all chats",
          )
          .onClick(() => {
            new DeleteAllConversationsModal(
              this.app,
              async () => {
                const deletedCount =
                  await this.localPlugin
                    .deleteAllConversations();

                new Notice(
                  `Deleted ${deletedCount} saved conversation(s).`,
                );

                this.display();
              },
            ).open();
          }),
      );

    new Setting(containerEl)
      .setName("Indexing")
      .setHeading();

    new Setting(containerEl)
      .setName(
        "Automatic indexing",
      )
      .setDesc(
        "Automatically re-index eligible sources after they change. When PDF/source indexing is disabled, only Markdown files are monitored.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.localPlugin
              .settings
              .autoIndex,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .autoIndex =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Index PDF/source material files",
      )
      .setDesc(
        "When enabled, PDF source materials are indexed alongside Markdown. Disable this for a Markdown-only knowledge index. Changing this setting requires a rebuild so old PDF chunks cannot remain searchable.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.localPlugin
              .settings
              .indexPdfSources,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .indexPdfSources =
                  value;

              await this.localPlugin
                .saveSettings();

              new Notice(
                value
                  ? "PDF/source indexing enabled. Rebuild the knowledge index to add PDF sources."
                  : "PDF/source indexing disabled. Rebuild the knowledge index to remove existing PDF sources and index Markdown only.",
              );

              this.display();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Concurrent source processing",
      )
      .setDesc(
        this.localPlugin
          .settings
          .indexPdfSources
          ? "How many Markdown/PDF sources may be prepared at once during a full rebuild. Actual file reads/writes are separately limited by Concurrent filesystem operations. Start at 3."
          : "How many Markdown sources may be prepared at once during a full rebuild. PDF/source indexing is currently disabled. Actual file reads/writes are separately limited by Concurrent filesystem operations. Start at 3.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            1,
            6,
            1,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .indexingConcurrency,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .indexingConcurrency =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Concurrent filesystem operations",
      )
      .setDesc(
        "Maximum number of actual vault/plugin file reads or writes allowed at once. Source processing can remain higher because CPU work continues after each read. Start at 2; use 1 for network, cloud-synced, external, or timeout-prone vaults.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            1,
            4,
            1,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .filesystemConcurrency,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .filesystemConcurrency =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Concurrent PDF page extraction",
      )
      .setDesc(
        "Global maximum number of PDF pages that PDF.js may extract at the same time across all active PDFs. Start at 6. This is separate from source concurrency so several books cannot each create an unbounded page pool.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            1,
            12,
            1,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .pdfPageConcurrency,
          )
          .setDisabled(
            !this.localPlugin
              .settings
              .indexPdfSources,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .pdfPageConcurrency =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Embedding batch size",
      )
      .setDesc(
        this.localPlugin
          .settings
          .useLocalEmbeddings
          ? "How many chunks are processed together by the local ONNX embedding model. 32 is a conservative default."
          : "How many chunks are sent to the Ollama embedding model in each /api/embed request. 32 is a conservative default.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            8,
            64,
            8,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .embeddingBatchSize,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .embeddingBatchSize =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );

    new Setting(containerEl)
      .setName(
        "Concurrent embedding requests",
      )
      .setDesc(
        this.localPlugin
          .settings
          .useLocalEmbeddings
          ? "Local embeddings use one shared batched ONNX pipeline, so Ollama request concurrency does not apply."
          : "Global maximum number of simultaneous /api/embed requests sent to Ollama during a rebuild. Start at 2.",
      )
      .addSlider((slider) =>
        slider
          .setLimits(
            1,
            4,
            1,
          )
          .setDynamicTooltip()
          .setValue(
            this.localPlugin
              .settings
              .embeddingConcurrency,
          )
          .setDisabled(
            this.localPlugin
              .settings
              .useLocalEmbeddings,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .embeddingConcurrency =
                  value;

              await this.localPlugin
                .saveSettings();
            },
          ),
      );


    const status =
      this.localPlugin
        .indexManager
        .getStatus();

    new Setting(containerEl)
      .setName("Index status")
      .setDesc(
        `${status.message}\n` +
          `${status.documentCount} source(s), ${status.chunkCount} chunk(s).`,
      );

    new Setting(containerEl)
      .setName(
        "Rebuild knowledge index",
      )
      .setDesc(
        "Recreates the knowledge index and embeddings from current Markdown/PDF sources using the selected local or Ollama embedding backend. Saved conversations are preserved. Parallel-indexing settings are applied when the rebuild starts.",
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText(
            "Rebuild index",
          )
          .onClick(async () => {
            button.setDisabled(
              true,
            );

            try {
              await this.localPlugin
                .indexManager
                .rebuildAll();

              new Notice(
                "Local Vault AI index rebuilt successfully.",
              );

              this.display();
            } catch (error) {
              new Notice(
                error instanceof
                  Error
                  ? error.message
                  : "Index rebuild failed.",
              );
            } finally {
              button.setDisabled(
                false,
              );
            }
          }),
      );

    this.ensureInitialModelCatalogLoad();
  }

  private configureModelDropdown(
    dropdown:
      DropdownComponent,

    purpose:
      OllamaModelPurpose,

    selected:
      string,

    disabled:
      boolean,

    onChange:
      (
        value:
          string,
      ) => Promise<void>,
  ): void {
    const snapshot =
      this.modelCatalog
        .getSnapshot();

    const models =
      this.modelCatalog
        .getModelsFor(
          purpose,
        );

    const available =
      new Set(
        models.map(
          (model) =>
            model.name,
        ),
      );

    /*
     * Always preserve the saved selection even if:
     *
     * - Ollama is offline,
     * - the catalog has not loaded yet,
     * - the model was removed from the server.
     *
     * The UI should never silently clear a saved model.
     */
    if (
      selected &&
      !available.has(
        selected,
      )
    ) {
      let label =
        selected;

      if (
        snapshot.status ===
        "ready"
      ) {
        label +=
          " — saved, not currently installed";
      } else if (
        snapshot.status ===
        "error"
      ) {
        label +=
          " — saved";
      }

      dropdown.addOption(
        selected,
        label,
      );
    }

    for (
      const model of
      models
    ) {
      dropdown.addOption(
        model.name,
        this.modelCatalog
          .formatOptionLabel(
            model,
          ),
      );
    }

    if (
      !selected &&
      models.length ===
        0
    ) {
      dropdown.addOption(
        "",
        snapshot.status ===
          "loading"
          ? "Loading models…"
          : "No models available",
      );
    }

    dropdown
      .setValue(
        selected,
      )
      .setDisabled(
        disabled ||
        (
          !selected &&
          models.length ===
            0
        ),
      )
      .onChange(
        (value) => {
          if (!value) {
            return;
          }

          void onChange(
            value,
          );
        },
      );
  }

  private modelCatalogDescription(
    snapshot:
      ReturnType<
        OllamaModelCatalog[
          "getSnapshot"
        ]
      >,
  ): string {
    switch (
      snapshot.status
    ) {
      case "loading":
        return (
          `Loading installed models from ${snapshot.serverUrl}…`
        );

      case "ready": {
        const generation =
          this.modelCatalog
            .getModelsFor(
              "generation",
            )
            .length;

        const embedding =
          this.modelCatalog
            .getModelsFor(
              "embedding",
            )
            .length;

        return (
          `${snapshot.models.length} installed model(s) loaded from ${snapshot.serverUrl}. ` +
          `${generation} available for generation; ${embedding} available for embeddings based on Ollama capability metadata. ` +
          "Model inspection uses /api/show and does not load the models into RAM."
        );
      }

      case "error":
        return (
          `Could not refresh models from ${snapshot.serverUrl}. ` +
          `${snapshot.error ?? "Unknown error."} ` +
          "Saved selections are preserved."
        );

      default:
        return (
          `Installed models have not been loaded from ${snapshot.serverUrl} yet.`
        );
    }
  }

  private ensureInitialModelCatalogLoad():
    void {
    const snapshot =
      this.modelCatalog
        .getSnapshot();

    if (
      snapshot.status !==
      "idle"
    ) {
      return;
    }

    /*
     * Refresh asynchronously so opening the settings
     * page itself remains immediate.
     */
    void this.modelCatalog
      .refresh()
      .then(() => {
        if (
          this.containerEl
            .isConnected
        ) {
          this.display();
        }
      })
      .catch(() => {
        if (
          this.containerEl
            .isConnected
        ) {
          this.display();
        }
      });
  }
}

class DeleteAllConversationsModal
  extends Modal {
  constructor(
    app: App,
    private readonly onConfirm:
      () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } =
      this;

    contentEl.empty();

    contentEl.createEl(
      "h2",
      {
        text:
          "Delete all conversations?",
      },
    );

    contentEl.createEl(
      "p",
      {
        text:
          "This permanently deletes every saved Local Vault AI conversation. " +
          "Your Obsidian notes and knowledge index will not be changed.",
      },
    );

    contentEl.createEl(
      "p",
      {
        text:
          "This action cannot be undone.",
      },
    );

    const buttons =
      contentEl.createDiv();

    const cancel =
      buttons.createEl(
        "button",
        {
          text: "Cancel",
        },
      );

    cancel.onclick = () => {
      this.close();
    };

    const confirm =
      buttons.createEl(
        "button",
        {
          text:
            "Delete all chats",
        },
      );

    confirm.addClass(
      "mod-warning",
    );

    confirm.onclick =
      async () => {
        confirm.disabled =
          true;

        cancel.disabled =
          true;

        try {
          await this.onConfirm();
          this.close();
        } catch (error) {
          new Notice(
            error instanceof
              Error
              ? error.message
              : "Could not delete conversations.",
          );

          confirm.disabled =
            false;

          cancel.disabled =
            false;
        }
      };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
