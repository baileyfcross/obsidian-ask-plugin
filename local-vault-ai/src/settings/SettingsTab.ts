import {
  App,
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

export class LocalVaultAISettingTab
  extends PluginSettingTab {
  constructor(
    app: App,
    private readonly localPlugin:
      LocalVaultAIPlugin,
  ) {
    super(
      app,
      localPlugin,
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
        "Primary model server. All chat, reasoning, lecture, and other generative model requests always use this Ollama server. If local embeddings are disabled, embedding requests use this same server too.",
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

    new Setting(containerEl)
      .setName(
        "General / Vault Explorer model",
      )
      .setDesc(
        "Used for normal vault questions, synthesis, comparisons, and general knowledge.",
      )
      .addText((text) =>
        text
          .setValue(
            this.localPlugin
              .settings
              .chatModel,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .chatModel =
                  value.trim();

              await this.localPlugin
                .saveSettings();
            },
          ),
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
      .addText((text) =>
        text
          .setValue(
            this.localPlugin
              .settings
              .lectureModel,
          )
          .onChange(
            async (value) => {
              this.localPlugin
                .settings
                .lectureModel =
                  value.trim();

              await this.localPlugin
                .saveSettings();
            },
          ),
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
      .addText((text) =>
        text
          .setValue(
            this.localPlugin
              .settings
              .embeddingModel,
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
                .embeddingModel =
                  value.trim();

              await this.localPlugin
                .saveSettings();
            },
          ),
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
        "Automatically re-index Markdown and PDF sources after they change.",
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
        "Concurrent source processing",
      )
      .setDesc(
        "How many Markdown/PDF sources may be prepared at once during a full rebuild. Actual file reads/writes are separately limited by Concurrent filesystem operations. Start at 3.",
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
