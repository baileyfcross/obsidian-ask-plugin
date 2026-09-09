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
import {
  RagStreamStage,
} from "../rag/RagService";

export const VIEW_TYPE_LOCAL_VAULT_AI =
  "local-vault-ai-view";

interface StreamingMessageUi {
  wrapper: HTMLElement;
  status: HTMLElement;
  reasoning: HTMLDetailsElement;
  reasoningSummary: HTMLElement;
  reasoningBody: HTMLElement;
  answerBody: HTMLElement;
  copyButton: HTMLButtonElement;
}

export class LocalVaultAIView
  extends ItemView {
  private currentConversation:
    | Conversation
    | null = null;

  private statusEl:
    | HTMLElement
    | null = null;

  private messagesEl:
    | HTMLElement
    | null = null;

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
    private readonly localPlugin:
      LocalVaultAIPlugin,
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
      this.localPlugin
        .indexManager
        .subscribe(
          (status) =>
            this.renderStatus(
              status,
            ),
        );
  }

  async onClose():
    Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus =
      null;
  }

  async resetAfterConversationClear():
    Promise<void> {
    this.currentConversation =
      null;

    await this.ensureConversation();
    await this
      .refreshConversationSelect();
    await this
      .renderConversation();
  }

  async refreshForSettingsChange():
    Promise<void> {
    await this
      .renderConversation();
  }

  private async renderShell():
    Promise<void> {
    const container =
      this.contentEl;

    container.empty();
    container.addClass(
      "local-vault-ai",
    );

    const toolbar =
      container.createDiv({
        cls:
          "local-vault-ai-toolbar",
      });

    this.conversationSelect =
      toolbar.createEl(
        "select",
      );

    this.conversationSelect
      .onchange =
      async () => {
        const id =
          this.conversationSelect
            ?.value;

        if (!id) {
          return;
        }

        const conversation =
          await this.localPlugin
            .conversationStore
            .get(id);

        if (conversation) {
          this.currentConversation =
            conversation;

          await this
            .renderConversation();
        }
      };

    const newButton =
      toolbar.createEl(
        "button",
        {
          text: "New",
        },
      );

    newButton.onclick =
      async () => {
        this.currentConversation =
          await this.localPlugin
            .conversationStore
            .create();

        await this
          .refreshConversationSelect();

        await this
          .renderConversation();
      };

    const deleteButton =
      toolbar.createEl(
        "button",
        {
          text: "Delete",
        },
      );

    deleteButton.onclick =
      async () => {
        if (
          !this
            .currentConversation
        ) {
          return;
        }

        await this.localPlugin
          .conversationStore
          .delete(
            this
              .currentConversation
              .id,
          );

        this.currentConversation =
          null;

        await this
          .ensureConversation();

        await this
          .refreshConversationSelect();

        await this
          .renderConversation();
      };

    this.statusEl =
      container.createDiv({
        cls:
          "local-vault-ai-status",
      });

    this.messagesEl =
      container.createDiv({
        cls:
          "local-vault-ai-messages",
      });

    const compose =
      container.createDiv({
        cls:
          "local-vault-ai-compose",
      });

    this.inputEl =
      compose.createEl(
        "textarea",
        {
          cls:
            "local-vault-ai-input",
          attr: {
            placeholder:
              "Ask a question about your vault...",
          },
        },
      );

    this.inputEl
      .addEventListener(
        "keydown",
        (event) => {
          if (
            event.key ===
              "Enter" &&
            !event.shiftKey
          ) {
            event.preventDefault();

            void this
              .submitQuestion();
          }
        },
      );

    const composeRow =
      compose.createDiv({
        cls:
          "local-vault-ai-compose-row",
      });

    const modeSelect =
      composeRow.createEl(
        "select",
      );

    const vaultOption =
      modeSelect.createEl(
        "option",
        {
          text:
            "Vault only",
        },
      );

    vaultOption.value =
      "vault";

    const mixedOption =
      modeSelect.createEl(
        "option",
        {
          text:
            "Vault + model",
        },
      );

    mixedOption.value =
      "mixed";

    modeSelect.value =
      this.localPlugin
        .settings.vaultOnly
        ? "vault"
        : "mixed";

    modeSelect.onchange =
      async () => {
        this.localPlugin
          .settings.vaultOnly =
          modeSelect.value ===
          "vault";

        await this.localPlugin
          .saveSettings();
      };

    this.askButton =
      composeRow.createEl(
        "button",
        {
          text: "Ask",
        },
      );

    this.askButton.onclick =
      () => {
        void this
          .submitQuestion();
      };

    await this.ensureConversation();
    await this
      .refreshConversationSelect();
    await this
      .renderConversation();

    this.renderStatus(
      this.localPlugin
        .indexManager
        .getStatus(),
    );
  }

  private async ensureConversation():
    Promise<void> {
    if (
      this.currentConversation
    ) {
      return;
    }

    const summaries =
      await this.localPlugin
        .conversationStore
        .list();

    const first =
      summaries[0];

    if (first) {
      this.currentConversation =
        await this.localPlugin
          .conversationStore
          .get(first.id);
    }

    if (
      !this.currentConversation
    ) {
      this.currentConversation =
        await this.localPlugin
          .conversationStore
          .create();
    }
  }

  private async refreshConversationSelect():
    Promise<void> {
    if (
      !this.conversationSelect
    ) {
      return;
    }

    const summaries =
      await this.localPlugin
        .conversationStore
        .list();

    this.conversationSelect
      .empty();

    for (
      const summary of
      summaries
    ) {
      const option =
        this.conversationSelect
          .createEl(
            "option",
            {
              text:
                summary.title,
            },
          );

      option.value =
        summary.id;
    }

    if (
      this.currentConversation
    ) {
      this.conversationSelect
        .value =
        this.currentConversation
          .id;
    }
  }

  private renderStatus(
    status: IndexStatus,
  ): void {
    if (!this.statusEl) {
      return;
    }

    this.statusEl
      .removeClass(
        "is-error",
        "is-indexing",
      );

    if (
      status.state === "error"
    ) {
      this.statusEl
        .addClass(
          "is-error",
        );
    }

    if (
      status.state ===
      "indexing"
    ) {
      this.statusEl
        .addClass(
          "is-indexing",
        );
    }

    this.statusEl.setText(
      `${status.message} ` +
        `(${status.documentCount} notes / ${status.chunkCount} chunks)`,
    );
  }

  private async renderConversation():
    Promise<void> {
    if (
      !this.messagesEl ||
      !this.currentConversation
    ) {
      return;
    }

    this.messagesEl.empty();

    if (
      this.currentConversation
        .messages.length === 0
    ) {
      this.messagesEl
        .createDiv({
          cls:
            "local-vault-ai-empty",
          text:
            "Ask a question about your indexed Obsidian vault.",
        });

      return;
    }

    for (
      const message of
      this.currentConversation
        .messages
    ) {
      await this.renderMessage(
        message,
      );
    }

    this.scrollToBottom();
  }

  private async renderMessage(
    message:
      ConversationMessage,
  ): Promise<void> {
    if (!this.messagesEl) {
      return;
    }

    const wrapper =
      this.messagesEl
        .createDiv({
          cls:
            `local-vault-ai-message ` +
            `local-vault-ai-message-${message.role}`,
        });

    const header =
      wrapper.createDiv({
        cls:
          "local-vault-ai-message-header",
      });

    header.createDiv({
      cls:
        "local-vault-ai-message-role",
      text:
        message.role === "user"
          ? "You"
          : "Local Vault AI",
    });

    if (
      message.role ===
      "assistant"
    ) {
      this.addCopyButton(
        header,
        () => message.content,
      );
    }

    if (
      message.role ===
        "assistant" &&
      this.localPlugin
        .settings
        .showModelReasoning &&
      message.thinking
    ) {
      const reasoning =
        wrapper.createEl(
          "details",
          {
            cls:
              "local-vault-ai-reasoning",
          },
        );

      reasoning.createEl(
        "summary",
        {
          text:
            "Reasoning",
        },
      );

      const reasoningBody =
        reasoning.createDiv({
          cls:
            "local-vault-ai-reasoning-body",
        });

      reasoningBody.setText(
        message.thinking,
      );
    }

    const body =
      wrapper.createDiv({
        cls:
          "local-vault-ai-message-body",
      });

    if (
      message.role ===
      "assistant"
    ) {
      await MarkdownRenderer
        .render(
          this.app,
          message.content,
          body,
          "",
          this,
        );
    } else {
      body.setText(
        message.content,
      );
    }

    if (
      message.sources &&
      message.sources.length >
        0
    ) {
      const sources =
        wrapper.createDiv({
          cls:
            "local-vault-ai-sources",
        });

      sources.createDiv({
        cls:
          "local-vault-ai-message-role",
        text: "Sources",
      });

      for (
        let index = 0;
        index <
        message.sources.length;
        index += 1
      ) {
        const source =
          message.sources[index];

        if (!source) {
          continue;
        }

        const pdfPageLabel =
          source.sourceType === "pdf" &&
          source.pageStart &&
          source.pageStart > 0
            ? source.pageEnd &&
              source.pageEnd !== source.pageStart
              ? ` (PDF pp. ${source.pageStart}-${source.pageEnd})`
              : ` (PDF p. ${source.pageStart})`
            : "";

        const button =
          sources.createEl(
            "button",
            {
              cls:
                "local-vault-ai-source",
              text:
                `[${index + 1}] ${source.filePath}` +
                pdfPageLabel +
                (source.heading
                  ? ` → ${source.heading}`
                  : ""),
            },
          );

        button.onclick =
          async () => {
            const file =
              this.app.vault
                .getAbstractFileByPath(
                  source.filePath,
                );

            if (
              file instanceof
              TFile
            ) {
              await this.app
                .workspace
                .getLeaf(false)
                .openFile(file);
            }
          };
      }
    }
  }

  private createStreamingMessage():
    StreamingMessageUi {
    if (!this.messagesEl) {
      throw new Error(
        "Messages container is not available.",
      );
    }

    const wrapper =
      this.messagesEl
        .createDiv({
          cls:
            "local-vault-ai-message local-vault-ai-message-assistant local-vault-ai-message-streaming",
        });

    const header =
      wrapper.createDiv({
        cls:
          "local-vault-ai-message-header",
      });

    header.createDiv({
      cls:
        "local-vault-ai-message-role",
      text:
        "Local Vault AI",
    });

    let currentAnswer = "";

    const copyButton =
      this.addCopyButton(
        header,
        () => currentAnswer,
      );

    copyButton.disabled =
      true;

    const status =
      wrapper.createDiv({
        cls:
          "local-vault-ai-live-status",
        text:
          "Retrieving vault context…",
      });

    const reasoning =
      wrapper.createEl(
        "details",
        {
          cls:
            "local-vault-ai-reasoning local-vault-ai-reasoning-live",
        },
      );

    reasoning.open = false;

    const reasoningSummary =
      reasoning.createEl(
        "summary",
        {
          text:
            "Reasoning",
        },
      );

    const reasoningBody =
      reasoning.createDiv({
        cls:
          "local-vault-ai-reasoning-body",
      });

    const answerBody =
      wrapper.createDiv({
        cls:
          "local-vault-ai-message-body local-vault-ai-live-answer",
      });

    /*
     * Keep the getter-backed copy content in sync
     * without storing another public UI property.
     */
    answerBody.dataset
      .copyText = "";

    const observer =
      new MutationObserver(
        () => {
          currentAnswer =
            answerBody.dataset
              .copyText ?? "";

          copyButton.disabled =
            currentAnswer.length ===
            0;
        },
      );

    observer.observe(
      answerBody,
      {
        attributes: true,
        attributeFilter: [
          "data-copy-text",
        ],
      },
    );

    wrapper.addEventListener(
      "DOMNodeRemoved",
      () => {
        observer.disconnect();
      },
      {
        once: true,
      },
    );

    return {
      wrapper,
      status,
      reasoning,
      reasoningSummary,
      reasoningBody,
      answerBody,
      copyButton,
    };
  }

  private updateStreamingStage(
    ui: StreamingMessageUi,
    stage: RagStreamStage,
  ): void {
    if (
      stage === "retrieving"
    ) {
      ui.status.setText(
        "Retrieving vault context…",
      );

      ui.status.addClass(
        "is-working",
      );

      return;
    }

    if (
      stage === "thinking"
    ) {
      ui.status.setText(
        "Model is reasoning…",
      );

      ui.status.addClass(
        "is-working",
      );

      if (
        this.localPlugin
          .settings
          .showModelReasoning
      ) {
        ui.reasoning.open =
          true;

        ui.reasoningSummary
          .setText(
            "Reasoning — working…",
          );
      }

      return;
    }

    ui.status.setText(
      "Writing answer…",
    );

    ui.status.addClass(
      "is-working",
    );

    ui.reasoningSummary
      .setText(
        "Reasoning",
      );

    /*
     * Reasoning remains visible while the model
     * works, then collapses once the final answer
     * begins so the answer gets the focus.
     */
    if (
      ui.reasoning.open
    ) {
      ui.reasoning.open =
        false;
    }
  }

  private addCopyButton(
    parent: HTMLElement,
    getText: () => string,
  ): HTMLButtonElement {
    const button =
      parent.createEl(
        "button",
        {
          cls:
            "local-vault-ai-copy-button",
          text: "Copy",
        },
      );

    button.onclick =
      async () => {
        const text =
          getText();

        if (!text) {
          return;
        }

        try {
          await navigator
            .clipboard
            .writeText(text);

          button.setText(
            "Copied",
          );

          window.setTimeout(
            () => {
              button.setText(
                "Copy",
              );
            },
            1200,
          );
        } catch {
          new Notice(
            "Could not copy the response.",
          );
        }
      };

    return button;
  }

  private async submitQuestion():
    Promise<void> {
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
      this.localPlugin
        .indexManager
        .getStatus();

    if (
      indexStatus.state !==
      "ready"
    ) {
      new Notice(
        "The knowledge index is not ready. Rebuild it from Local Vault AI settings.",
      );

      return;
    }

    const priorHistory = [
      ...this.currentConversation
        .messages,
    ];

    const userMessage:
      ConversationMessage = {
        id:
          crypto.randomUUID(),
        role: "user",
        content: question,
        createdAt:
          new Date()
            .toISOString(),
      };

    this.currentConversation =
      await this.localPlugin
        .conversationStore
        .appendMessage(
          this
            .currentConversation,
          userMessage,
        );

    this.inputEl.value = "";
    this.askButton.disabled =
      true;
    this.askButton.setText(
      "Working…",
    );

    await this
      .refreshConversationSelect();

    await this
      .renderConversation();

    const streamingUi =
      this.createStreamingMessage();

    this.scrollToBottom();

    try {
      const result =
        await this.localPlugin
          .ragService
          .askStreaming(
            question,
            priorHistory,
            {
              onStage:
                (stage) => {
                  this.updateStreamingStage(
                    streamingUi,
                    stage,
                  );

                  this.scrollToBottom();
                },

              onRetrievalInfo:
                (info) => {
                  const parts:
                    string[] = [];

                  if (
                    info.sourceFile
                  ) {
                    parts.push(
                      info.sourceFile,
                    );
                  }

                  if (
                    info.section
                  ) {
                    parts.push(
                      `section ${info.section}`,
                    );
                  }

                  parts.push(
                    `${info.chunkCount} chunk${info.chunkCount === 1 ? "" : "s"}`,
                  );

                  parts.push(
                    `${info.contextCharacters.toLocaleString()} chars`,
                  );

                  streamingUi
                    .status
                    .setText(
                      `Retrieved ${parts.join(" · ")}…`,
                    );

                  streamingUi
                    .status
                    .addClass(
                      "is-working",
                    );

                  this.scrollToBottom();
                },

              onThinking:
                (thinking) => {
                  if (
                    !this.localPlugin
                      .settings
                      .showModelReasoning
                  ) {
                    return;
                  }

                  streamingUi
                    .reasoningBody
                    .setText(
                      thinking,
                    );

                  streamingUi
                    .reasoning
                    .open =
                    true;

                  this.scrollToBottom();
                },

              onAnswer:
                (answer) => {
                  /*
                   * During generation use plain text
                   * to avoid re-running the Markdown
                   * renderer on every token. The
                   * persisted final message is rendered
                   * as Markdown after completion.
                   */
                  streamingUi
                    .answerBody
                    .setText(
                      answer,
                    );

                  streamingUi
                    .answerBody
                    .dataset
                    .copyText =
                    answer;

                  this.scrollToBottom();
                },
            },
          );

      streamingUi.status
        .removeClass(
          "is-working",
        );

      streamingUi.status.setText(
        "Complete",
      );

      const assistantMessage:
        ConversationMessage = {
          id:
            crypto.randomUUID(),
          role: "assistant",
          content:
            result.answer,
          thinking:
            result.thinking,
          createdAt:
            new Date()
              .toISOString(),
          sources:
            result.sources.map(
              (source) => ({
                filePath:
                  source.filePath,
                heading:
                  source.heading,
                score:
                  source.score,
                sourceType:
                  source.sourceType,
                pageStart:
                  source.pageStart,
                pageEnd:
                  source.pageEnd,
              }),
            ),
        };

      this.currentConversation =
        await this.localPlugin
          .conversationStore
          .appendMessage(
            this
              .currentConversation,
            assistantMessage,
          );

      /*
       * Replace the temporary streaming card
       * with the normal persisted Markdown-rendered
       * conversation message.
       */
      await this
        .renderConversation();
    } catch (error) {
      streamingUi.status
        .removeClass(
          "is-working",
        );

      streamingUi.status
        .addClass(
          "is-error",
        );

      streamingUi.status.setText(
        "Request failed",
      );

      new Notice(
        error instanceof Error
          ? error.message
          : "Local Vault AI request failed.",
      );
    } finally {
      this.askButton.disabled =
        false;

      this.askButton.setText(
        "Ask",
      );

      this.inputEl.focus();
    }
  }

  private scrollToBottom():
    void {
    if (!this.messagesEl) {
      return;
    }

    this.messagesEl.scrollTop =
      this.messagesEl.scrollHeight;
  }
}
