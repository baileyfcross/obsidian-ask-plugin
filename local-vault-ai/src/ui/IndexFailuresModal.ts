import {
  App,
  Modal,
  TFile,
} from "obsidian";
import type {
  IndexFailureRecord,
  IndexFailureStore,
} from "../indexing/IndexFailureStore";

export class IndexFailuresModal
  extends Modal {
  private unsubscribe:
    | (() => void)
    | null = null;

  constructor(
    app: App,
    private readonly failureStore:
      IndexFailureStore,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass(
      "local-vault-ai-index-failures-modal",
    );

    this.render();

    this.unsubscribe =
      this.failureStore
        .onChange(
          () => {
            this.render();
          },
        );
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    const failures =
      this.failureStore
        .getAll();

    this.contentEl.createEl(
      "h2",
      {
        text:
          `Failed indexes (${failures.length})`,
      },
    );

    if (
      failures.length === 0
    ) {
      this.contentEl.createEl(
        "p",
        {
          text:
            "There are currently no failed source indexes.",
        },
      );

      return;
    }

    this.contentEl.createEl(
      "p",
      {
        cls:
          "local-vault-ai-index-failures-description",

        text:
          "These sources were skipped after indexing failed. " +
          "Other sources continued indexing normally. " +
          "A source disappears from this list automatically after it indexes successfully.",
      },
    );

    const list =
      this.contentEl.createDiv({
        cls:
          "local-vault-ai-index-failure-list",
      });

    for (
      const failure of
      failures
    ) {
      this.renderFailure(
        list,
        failure,
      );
    }
  }

  private renderFailure(
    parent: HTMLElement,
    failure:
      IndexFailureRecord,
  ): void {
    const item =
      parent.createDiv({
        cls:
          "local-vault-ai-index-failure-item",
      });

    const header =
      item.createDiv({
        cls:
          "local-vault-ai-index-failure-header",
      });

    header.createEl(
      "strong",
      {
        text:
          this.getFileName(
            failure.path,
          ),
      },
    );

    item.createDiv({
      cls:
        "local-vault-ai-index-failure-path",

      text:
        failure.path,
    });

    const details =
      item.createDiv({
        cls:
          "local-vault-ai-index-failure-details",
      });

    details.createDiv({
      text:
        `Type: ${
          failure.extension
            ? failure.extension
                .toUpperCase()
            : "Unknown"
        }`,
    });

    details.createDiv({
      text:
        `Attempts: ${failure.attempts}`,
    });

    details.createDiv({
      text:
        `Last failure: ${
          new Date(
            failure.lastFailedAt,
          ).toLocaleString()
        }`,
    });

    const error =
      item.createDiv({
        cls:
          "local-vault-ai-index-failure-error",
      });

    error.createEl(
      "strong",
      {
        text: "Error",
      },
    );

    error.createEl(
      "pre",
      {
        text:
          failure.message,
      },
    );

    const source =
      this.app.vault
        .getAbstractFileByPath(
          failure.path,
        );

    if (
      source instanceof TFile
    ) {
      const actions =
        item.createDiv({
          cls:
            "local-vault-ai-index-failure-actions",
        });

      const openButton =
        actions.createEl(
          "button",
          {
            text:
              "Open source",
          },
        );

      openButton.onclick =
        () => {
          void this.app
            .workspace
            .getLeaf(true)
            .openFile(
              source,
            );
        };
    }
  }

  private getFileName(
    path: string,
  ): string {
    const parts =
      path.split("/");

    return (
      parts[
        parts.length - 1
      ] ?? path
    );
  }
}
