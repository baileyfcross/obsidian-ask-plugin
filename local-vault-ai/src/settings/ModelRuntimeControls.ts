import {
  App,
  Modal,
  Notice,
  Setting,
} from "obsidian";
import type LocalVaultAIPlugin from "../main";
import {
  ModelRuntimeState,
  ModelUnloadResult,
} from "../ollama/ModelRuntimeManager";
import {
  OllamaRunningModel,
} from "../ollama/OllamaClient";

interface ConfiguredModel {
  role: string;
  name: string;
}

export function addModelRuntimeSettings(
  containerEl: HTMLElement,
  localPlugin: LocalVaultAIPlugin,
): void {
  new Setting(containerEl)
    .setName("Model runtime")
    .setHeading();

  new Setting(containerEl)
    .setName("Unload Local Vault AI models")
    .setDesc(
      "Frees Ollama RAM/VRAM used by this plugin. " +
        "Active index, chat, and lecture jobs are never interrupted.",
    )
    .addButton((button) =>
      button
        .setButtonText("Manage models")
        .onClick(() => {
          new ModelRuntimeModal(
            localPlugin.app,
            localPlugin,
          ).open();
        }),
    );
}

class ModelRuntimeModal extends Modal {
  private readonly models:
    ConfiguredModel[];

  constructor(
    app: App,
    private readonly localPlugin:
      LocalVaultAIPlugin,
  ) {
    super(app);

    this.models =
      this.getConfiguredModels();
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl("h2", {
      text: "Local Vault AI model runtime",
    });

    contentEl.createEl("p", {
      text:
        "Only models configured for Local Vault AI are targeted. " +
        "A model being used by an active Local Vault AI job will not be interrupted.",
    });

    let running:
      OllamaRunningModel[];

    try {
      running =
        await this.localPlugin.ollama
          .listRunningModels();
    } catch (error) {
      contentEl.createEl("p", {
        text:
          error instanceof Error
            ? error.message
            : "Could not query Ollama.",
      });

      this.addCloseButton();
      return;
    }

    const names =
      this.models.map(
        (model) => model.name,
      );

    const states =
      this.localPlugin.modelRuntime
        .getModelStates(names);

    this.renderModelStates(
      running,
      states,
    );

    const busyCount =
      states.filter(
        (state) =>
          state.activeLeaseCount > 0,
      ).length;

    const queuedCount =
      states.filter(
        (state) =>
          state.unloadQueued,
      ).length;

    if (busyCount > 0) {
      contentEl.createEl("p", {
        text:
          "Busy models will be queued to unload after their entire current job finishes. " +
          "For example, an embedding model will remain available for every batch of an index rebuild.",
      });
    }

    if (queuedCount > 0) {
      contentEl.createEl("p", {
        text:
          "A queued unload blocks new Local Vault AI jobs from acquiring that model until the unload finishes or you cancel the queue.",
      });
    }

    const buttons =
      contentEl.createDiv();

    const close =
      buttons.createEl("button", {
        text: "Close",
      });

    close.onclick = () => {
      this.close();
    };

    if (queuedCount > 0) {
      const cancelQueue =
        buttons.createEl("button", {
          text: "Cancel queued unloads",
        });

      cancelQueue.onclick = () => {
        const cancelled =
          this.localPlugin.modelRuntime
            .cancelQueuedUnloads(
              names,
            );

        new Notice(
          `Cancelled ${cancelled} queued model unload(s).`,
        );

        void this.render();
      };
    }

    const unload =
      buttons.createEl("button", {
        text:
          busyCount > 0
            ? "Unload all when safe"
            : "Unload all now",
      });

    unload.addClass("mod-warning");

    unload.onclick = async () => {
      unload.disabled = true;
      close.disabled = true;

      try {
        const results =
          await this.localPlugin.modelRuntime
            .requestUnload(names);

        this.showResults(results);

        await this.render();
      } catch (error) {
        new Notice(
          error instanceof Error
            ? error.message
            : "Could not unload Ollama models.",
        );

        unload.disabled = false;
        close.disabled = false;
      }
    };
  }

  private renderModelStates(
    running: OllamaRunningModel[],
    states: ModelRuntimeState[],
  ): void {
    for (const configured of
      this.models) {
      const state =
        states.find(
          (item) =>
            item.model ===
            configured.name,
        );

      const loaded =
        running.some(
          (model) =>
            this.localPlugin.ollama
              .modelNamesMatch(
                configured.name,
                model.name,
              ) ||
            this.localPlugin.ollama
              .modelNamesMatch(
                configured.name,
                model.model,
              ),
        );

      const wrapper =
        this.contentEl.createDiv();

      const title =
        wrapper.createEl("p");

      title.createEl("strong", {
        text:
          `${configured.role}: `,
      });

      title.appendText(
        configured.name,
      );

      if (!state) {
        continue;
      }

      let runtimeText =
        loaded
          ? "Loaded"
          : "Not loaded";

      if (state.unloadInFlight) {
        runtimeText =
          "Unloading";
      } else if (
        state.activeLeaseCount > 0
      ) {
        runtimeText =
          `Busy — ${state.activeLeaseCount} active job(s)`;
      } else if (
        state.unloadQueued
      ) {
        runtimeText =
          "Unload queued";
      }

      wrapper.createEl("p", {
        text: runtimeText,
      });

      for (const job of
        state.activeJobs) {
        wrapper.createEl("div", {
          text:
            `• ${job.label}`,
        });
      }

      if (state.lastUnloadError) {
        wrapper.createEl("p", {
          text:
            `Last unload error: ${state.lastUnloadError}`,
        });
      }
    }
  }

  private getConfiguredModels():
    ConfiguredModel[] {
    const settings =
      this.localPlugin.settings;

    const candidates:
      ConfiguredModel[] = [
        {
          role: "Chat",
          name:
            settings.chatModel,
        },
        {
          role: "Embedding",
          name:
            settings.embeddingModel,
        },
      ];

    const lectureModel =
      (
        settings as typeof settings & {
          lectureModel?: string;
        }
      ).lectureModel;

    if (lectureModel) {
      candidates.splice(
        1,
        0,
        {
          role: "Lecture",
          name: lectureModel,
        },
      );
    }

    const seen =
      new Set<string>();

    return candidates.filter(
      (item) => {
        if (
          !item.name ||
          seen.has(item.name)
        ) {
          return false;
        }

        seen.add(item.name);
        return true;
      },
    );
  }

  private showResults(
    results: ModelUnloadResult[],
  ): void {
    const unloaded =
      results.filter(
        (result) =>
          result.status === "unloaded",
      ).length;

    const queued =
      results.filter(
        (result) =>
          result.status === "queued",
      ).length;

    const notLoaded =
      results.filter(
        (result) =>
          result.status === "not-loaded",
      ).length;

    const messages: string[] = [];

    if (unloaded > 0) {
      messages.push(
        `${unloaded} unloaded`,
      );
    }

    if (queued > 0) {
      messages.push(
        `${queued} queued until current work finishes`,
      );
    }

    if (notLoaded > 0) {
      messages.push(
        `${notLoaded} already not loaded`,
      );
    }

    new Notice(
      messages.length > 0
        ? `Models: ${messages.join(", ")}.`
        : "No model state changed.",
    );
  }

  private addCloseButton(): void {
    const button =
      this.contentEl.createEl("button", {
        text: "Close",
      });

    button.onclick = () => {
      this.close();
    };
  }
}
