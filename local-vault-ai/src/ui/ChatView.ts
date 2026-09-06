import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type LocalVaultAIPlugin from "../main";
import {
  Conversation,
  ConversationMessage,
  IndexStatus,
} from "../types";

export const VIEW_TYPE_LOCAL_VAULT_AI =
  "local-vault-ai-view";

export class LocalVaultAIView extends ItemView {
  private currentConversation:
    | Conversation
    | null = null;

  private statusEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private conversationSelect:
    | HTMLSelectElement
    | null = null;
  private inputEl:
    | HTMLTextAreaElement
    | null = null;
  private askButton:
    | HTMLButtonElement
    | null = null;

  private unsubscribeStatus:
    | (() => void)
    | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly localPlugin: LocalVaultAIPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LOCAL_VAULT_AI;
  }

  getDisplayText(): string {
    return "Local Vault AI";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    await this.renderShell();

    this.unsubscribeStatus =
      this.localPlugin.indexManager.subscribe(
        (status) =>
          this.renderStatus(status),
      );
  }

  async onClose(): Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  async resetAfterConversationClear(): Promise<void> {
    this.currentConversation = null;

    await this.ensureConversation();
    await this.refreshConversationSelect();
    await this.renderConversation();
  }

  private async renderShell(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("local-vault-ai");

    const toolbar = container.createDiv({
      cls: "local-vault-ai-toolbar",
    });

    this.conversationSelect =
      toolbar.createEl("select");

    this.conversationSelect.onchange =
      async () => {
        const id =
          this.conversationSelect?.value;

        if (!id) {
          return;
        }

        const conversation =
          await this.localPlugin.conversationStore.get(
            id,
          );

        if (conversation) {
          this.currentConversation =
            conversation;

          await this.renderConversation();
        }
      };

    const newButton =
      toolbar.createEl("button", {
        text: "New",
      });

    newButton.onclick = async () => {
      this.currentConversation =
        await this.localPlugin.conversationStore.create();

      await this.refreshConversationSelect();
      await this.renderConversation();
    };

    const deleteButton =
      toolbar.createEl("button", {
        text: "Delete",
      });

    deleteButton.onclick = async () => {
      if (!this.currentConversation) {
        return;
      }

      await this.localPlugin.conversationStore.delete(
        this.currentConversation.id,
      );

      this.currentConversation = null;
      await this.ensureConversation();
      await this.refreshConversationSelect();
      await this.renderConversation();
    };

    this.statusEl = container.createDiv({
      cls: "local-vault-ai-status",
    });

    this.messagesEl = container.createDiv({
      cls: "local-vault-ai-messages",
    });

    const compose = container.createDiv({
      cls: "local-vault-ai-compose",
    });

    this.inputEl =
      compose.createEl("textarea", {
        cls: "local-vault-ai-input",
        attr: {
          placeholder:
            "Ask a question about your vault...",
        },
      });

    this.inputEl.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          void this.submitQuestion();
        }
      },
    );

    const composeRow =
      compose.createDiv({
        cls: "local-vault-ai-compose-row",
      });

    const modeSelect =
      composeRow.createEl("select");

    const vaultOption =
      modeSelect.createEl("option", {
        text: "Vault only",
      });
    vaultOption.value = "vault";

    const mixedOption =
      modeSelect.createEl("option", {
        text: "Vault + model",
      });
    mixedOption.value = "mixed";

    modeSelect.value =
      this.localPlugin.settings.vaultOnly
        ? "vault"
        : "mixed";

    modeSelect.onchange = async () => {
      this.localPlugin.settings.vaultOnly =
        modeSelect.value === "vault";

      await this.localPlugin.saveSettings();
    };

    this.askButton =
      composeRow.createEl("button", {
        text: "Ask",
      });

    this.askButton.onclick = () => {
      void this.submitQuestion();
    };

    await this.ensureConversation();
    await this.refreshConversationSelect();
    await this.renderConversation();

    this.renderStatus(
      this.localPlugin.indexManager.getStatus(),
    );
  }

  private async ensureConversation(): Promise<void> {
    if (this.currentConversation) {
      return;
    }

    const summaries =
      await this.localPlugin.conversationStore.list();

    const first = summaries[0];

    if (first) {
      this.currentConversation =
        await this.localPlugin.conversationStore.get(
          first.id,
        );
    }

    if (!this.currentConversation) {
      this.currentConversation =
        await this.localPlugin.conversationStore.create();
    }
  }

  private async refreshConversationSelect(): Promise<void> {
    if (!this.conversationSelect) {
      return;
    }

    const summaries =
      await this.localPlugin.conversationStore.list();

    this.conversationSelect.empty();

    for (const summary of summaries) {
      const option =
        this.conversationSelect.createEl(
          "option",
          {
            text: summary.title,
          },
        );

      option.value = summary.id;
    }

    if (this.currentConversation) {
      this.conversationSelect.value =
        this.currentConversation.id;
    }
  }

  private renderStatus(
    status: IndexStatus,
  ): void {
    if (!this.statusEl) {
      return;
    }

    this.statusEl.removeClass(
      "is-error",
      "is-indexing",
    );

    if (status.state === "error") {
      this.statusEl.addClass("is-error");
    }

    if (status.state === "indexing") {
      this.statusEl.addClass(
        "is-indexing",
      );
    }

    this.statusEl.setText(
      `${status.message} ` +
        `(${status.documentCount} notes / ${status.chunkCount} chunks)`,
    );
  }

  private async renderConversation(): Promise<void> {
    if (
      !this.messagesEl ||
      !this.currentConversation
    ) {
      return;
    }

    this.messagesEl.empty();

    if (
      this.currentConversation.messages.length === 0
    ) {
      this.messagesEl.createDiv({
        cls: "local-vault-ai-empty",
        text:
          "Ask a question about your indexed Obsidian vault.",
      });
      return;
    }

    for (const message of
      this.currentConversation.messages) {
      await this.renderMessage(message);
    }

    this.scrollToBottom();
  }

  private async renderMessage(
    message: ConversationMessage,
  ): Promise<void> {
    if (!this.messagesEl) {
      return;
    }

    const wrapper =
      this.messagesEl.createDiv({
        cls:
          `local-vault-ai-message ` +
          `local-vault-ai-message-${message.role}`,
      });

    wrapper.createDiv({
      cls: "local-vault-ai-message-role",
      text:
        message.role === "user"
          ? "You"
          : "Local Vault AI",
    });

    const body = wrapper.createDiv({
      cls: "local-vault-ai-message-body",
    });

    if (message.role === "assistant") {
      await MarkdownRenderer.render(
        this.app,
        message.content,
        body,
        "",
        this,
      );
    } else {
      body.setText(message.content);
    }

    if (
      message.sources &&
      message.sources.length > 0
    ) {
      const sources =
        wrapper.createDiv({
          cls: "local-vault-ai-sources",
        });

      sources.createDiv({
        cls: "local-vault-ai-message-role",
        text: "Sources",
      });

      for (
        let index = 0;
        index < message.sources.length;
        index += 1
      ) {
        const source =
          message.sources[index];

        if (!source) {
          continue;
        }

        const button =
          sources.createEl("button", {
            cls: "local-vault-ai-source",
            text:
              `[${index + 1}] ${source.filePath}` +
              (source.heading
                ? ` → ${source.heading}`
                : ""),
          });

        button.onclick = async () => {
          const file =
            this.app.vault.getAbstractFileByPath(
              source.filePath,
            );

          if (file instanceof TFile) {
            await this.app.workspace
              .getLeaf(false)
              .openFile(file);
          }
        };
      }
    }
  }

  private async submitQuestion(): Promise<void> {
    if (
      !this.currentConversation ||
      !this.inputEl ||
      !this.askButton
    ) {
      return;
    }

    const question =
      this.inputEl.value.trim();

    if (!question) {
      return;
    }

    const indexStatus =
      this.localPlugin.indexManager.getStatus();

    if (indexStatus.state !== "ready") {
      new Notice(
        "The knowledge index is not ready. Rebuild it from Local Vault AI settings.",
      );
      return;
    }

    const priorHistory = [
      ...this.currentConversation.messages,
    ];

    const userMessage: ConversationMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
    };

    this.currentConversation =
      await this.localPlugin.conversationStore.appendMessage(
        this.currentConversation,
        userMessage,
      );

    this.inputEl.value = "";
    this.askButton.disabled = true;
    this.askButton.setText("Thinking...");

    await this.refreshConversationSelect();
    await this.renderConversation();

    try {
      const result =
        await this.localPlugin.ragService.ask(
          question,
          priorHistory,
        );

      const assistantMessage: ConversationMessage =
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.answer,
          createdAt:
            new Date().toISOString(),
          sources: result.sources.map(
            (source) => ({
              filePath: source.filePath,
              heading: source.heading,
              score: source.score,
            }),
          ),
        };

      this.currentConversation =
        await this.localPlugin.conversationStore.appendMessage(
          this.currentConversation,
          assistantMessage,
        );

      await this.renderConversation();
    } catch (error) {
      new Notice(
        error instanceof Error
          ? error.message
          : "Local Vault AI request failed.",
      );
    } finally {
      this.askButton.disabled = false;
      this.askButton.setText("Ask");
      this.inputEl.focus();
    }
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) {
      return;
    }

    this.messagesEl.scrollTop =
      this.messagesEl.scrollHeight;
  }
}
