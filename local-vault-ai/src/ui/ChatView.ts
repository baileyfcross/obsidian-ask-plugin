import {
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
} from "obsidian";
import type LocalVaultAIPlugin from "../main";
import {
  Conversation,
  ConversationMessage,
  ConversationSource,
  IndexStatus,
  RagStageTimings,
  RetrievedChunk,
} from "../types";
import {
  RagStreamStage,
} from "../rag/RagService";
import {
  SourceNavigator,
} from "./SourceNavigator";

export const VIEW_TYPE_LOCAL_VAULT_AI =
  "local-vault-ai-view";

interface StreamingMessageUi {
  wrapper: HTMLElement;
  role: HTMLElement;
  status: HTMLElement;
  timingsEl: HTMLElement;
  reasoning: HTMLDetailsElement;
  reasoningSummary: HTMLElement;
  reasoningBody: HTMLElement;
  answerBody: HTMLElement;
  copyButton: HTMLButtonElement;

  /*
   * Live elapsed-request timer state.
   *
   * The timer starts immediately before RAG processing
   * and freezes when the request completes, is stopped,
   * or fails.
   */
  startedAt: number;
  timerIntervalId:
    number | null;
  finalElapsedMs:
    number | null;

  stageTimings:
    RagStageTimings;

  currentStage:
    RagStreamStage;

  stageStartedAt:
    number;
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

  private stopButton:
    | HTMLButtonElement
    | null = null;

  /*
   * Only one chat request may be active per view.
   * The controller is created when a request starts
   * and cleared in submitQuestion()'s finally block.
   */
  private activeRequestController:
    | AbortController
    | null = null;

  private activeStreamingUi:
    | StreamingMessageUi
    | null = null;

  private unsubscribeStatus:
    | (() => void)
    | null = null;

  private readonly sourceNavigator:
    SourceNavigator;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly localPlugin:
      LocalVaultAIPlugin,
  ) {
    super(leaf);

    this.sourceNavigator =
      new SourceNavigator(
        this.app,
      );
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
    this.stopActiveRequest(
      false,
    );

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

    this.stopButton =
      composeRow.createEl(
        "button",
        {
          text:
            "Stop",
        },
      );

    this.stopButton.disabled =
      true;

    this.stopButton.onclick =
      () => {
        this.stopActiveRequest(
          true,
        );
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

    const stateClass =
      message.requestState ===
        "error"
        ? " local-vault-ai-message-error"
        : message.requestState ===
            "stopped"
          ? " local-vault-ai-message-stopped"
          : "";

    const wrapper =
      this.messagesEl
        .createDiv({
          cls:
            `local-vault-ai-message ` +
            `local-vault-ai-message-${message.role}` +
            stateClass,
        });

    const header =
      wrapper.createDiv({
        cls:
          "local-vault-ai-message-header",
      });

    const baseRoleText =
      message.role ===
        "user"
        ? message.requestState ===
            "error"
          ? "You — failed request"
          : message.requestState ===
              "stopped"
            ? "You — stopped request"
            : "You"
        : message.requestState ===
            "error"
          ? "Local Vault AI — Request failed"
          : message.requestState ===
              "stopped"
            ? "Local Vault AI — Stopped"
            : "Local Vault AI";

    const durationText =
      message.role ===
        "assistant" &&
      typeof message
        .generationDurationMs ===
        "number" &&
      Number.isFinite(
        message
          .generationDurationMs,
      )
        ? ` · ${this.formatElapsedTime(
            message
              .generationDurationMs,
          )}`
        : "";

    header.createDiv({
      cls:
        "local-vault-ai-message-role",

      text:
        baseRoleText +
        durationText,
    });

    if (
      message.role ===
      "assistant"
    ) {
      this.addCopyButton(
        header,
        () => message.content,
      );

      if (
        message.stageTimings
      ) {
        wrapper.createDiv({
          cls:
            "local-vault-ai-stage-timings",

          text:
            this.formatStageTimings(
              message.stageTimings,
            ),
        });
      }
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

        const sectionLabel =
          source.sectionNumber
            ? ` → §${source.sectionNumber}` +
              (source.sectionTitle
                ? ` ${source.sectionTitle}`
                : "")
            : source.heading
              ? ` → ${source.heading}`
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
                sectionLabel,
            },
          );

        const navigationTarget =
          this.sourceNavigator
            .buildTarget(
              source,
            );

        button.setAttribute(
          "title",
          navigationTarget
            .description +
            " · Ctrl/Cmd-click or middle-click opens in a new tab",
        );

        button.setAttribute(
          "aria-label",
          navigationTarget
            .description,
        );

        /*
         * Left click:
         *   open the precise citation location.
         *
         * Ctrl/Cmd-click:
         *   open in a new Obsidian leaf/tab.
         *
         * Middle click:
         *   also open in a new leaf/tab.
         */
        button.addEventListener(
          "click",
          (event) => {
            event.preventDefault();

            void this
              .openSourceCitation(
                source,
                event,
              );
          },
        );

        button.addEventListener(
          "auxclick",
          (event) => {
            if (
              event.button !==
              1
            ) {
              return;
            }

            event.preventDefault();

            void this
              .openSourceCitation(
                source,
                event,
              );
          },
        );

        /*
         * Give Obsidian's native hover-link system the
         * same precise target. This allows the normal
         * link-preview behavior when enabled.
         */
        button.addEventListener(
          "mouseover",
          (event) => {
            this.app.workspace
              .trigger(
                "hover-link",
                {
                  event,
                  source:
                    "local-vault-ai",
                  hoverParent:
                    this,
                  targetEl:
                    button,
                  linktext:
                    navigationTarget
                      .linkText,
                  sourcePath:
                    "",
                },
              );
          },
        );
      }
    }
  }

  private async openSourceCitation(
    source:
      ConversationSource,

    event:
      MouseEvent,
  ): Promise<void> {
    await this.sourceNavigator
      .open(
        source,
        event,
      );
  }

  private createStreamingMessage(
    startedAt:
      number,
  ):
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

    const role =
      header.createDiv({
        cls:
          "local-vault-ai-message-role",
        text:
          "Local Vault AI · 00:00",
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

    const timingsEl =
      wrapper.createDiv({
        cls:
          "local-vault-ai-stage-timings local-vault-ai-stage-timings-live",

        text:
          "Retrieval: 0.0s · Model startup: — · Prompt processing: — · Reasoning: — · Answering: —",
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

    const ui:
      StreamingMessageUi = {
      wrapper,
      role,
      status,
      timingsEl,
      reasoning,
      reasoningSummary,
      reasoningBody,
      answerBody,
      copyButton,

      startedAt,

      timerIntervalId:
        null,

      finalElapsedMs:
        null,

      stageTimings: {},

      currentStage:
        "retrieving",

      stageStartedAt:
        startedAt,
    };

    /*
     * Update four times per second while displaying
     * whole elapsed seconds. This keeps the transition
     * to the next second visually responsive without
     * adding meaningful overhead.
     */
    this.updateStreamingTimer(
      ui,
    );

    ui.timerIntervalId =
      window.setInterval(
        () => {
          this.updateStreamingTimer(
            ui,
          );
        },
        250,
      );

    wrapper.addEventListener(
      "DOMNodeRemoved",
      () => {
        observer.disconnect();

        if (
          ui.timerIntervalId !==
          null
        ) {
          window.clearInterval(
            ui.timerIntervalId,
          );

          ui.timerIntervalId =
            null;
        }
      },
      {
        once: true,
      },
    );

    return ui;
  }

  private updateStreamingStage(
    ui: StreamingMessageUi,
    stage: RagStreamStage,
  ): void {
    const now =
      performance.now();

    this.finalizeStageTransition(
      ui,
      stage,
      now,
    );

    if (
      stage === "retrieving"
    ) {
      ui.status.setText(
        "Retrieving vault context…",
      );

      ui.status.addClass(
        "is-working",
      );

      this.updateStageTimingsDisplay(
        ui,
      );

      return;
    }

    if (
      stage === "model"
    ) {
      ui.status.setText(
        "Starting model and processing prompt…",
      );

      ui.status.addClass(
        "is-working",
      );

      this.updateStageTimingsDisplay(
        ui,
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

      this.updateStageTimingsDisplay(
        ui,
      );

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

    if (
      ui.reasoning.open
    ) {
      ui.reasoning.open =
        false;
    }

    this.updateStageTimingsDisplay(
      ui,
    );
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

    if (
      this.activeRequestController
    ) {
      new Notice(
        "A Local Vault AI request is already running. Stop it before starting another request.",
      );

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

    /*
     * Failed turns stay visible in the conversation UI
     * for debugging, but they must not become model
     * context for later prompts.
     *
     * This preserves the earlier transactional behavior
     * at the RAG level while still keeping the failure
     * permanently visible to the user.
     */
    const priorHistory =
      this.currentConversation
        .messages
        .filter(
          (message) =>
            message.requestState !==
            "error",
        );

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

    /*
     * Do not persist the user message until the RAG
     * request succeeds. A normal retrieval/search
     * failure must not become conversation history.
     *
     * User cancellation is handled separately below:
     * a deliberately stopped turn is saved so partial
     * work remains available in the conversation.
     */
    const requestController =
      new AbortController();

    this.activeRequestController =
      requestController;

    let latestAnswer = "";
    let latestThinking = "";

    let latestSources:
      RetrievedChunk[] = [];

    this.inputEl.value = "";

    this.setRequestControls(
      true,
    );

    /*
     * Render the pending user message only in the UI.
     * It is transient until the request completes.
     */
    if (
      this.currentConversation
        .messages.length === 0 &&
      this.messagesEl
    ) {
      this.messagesEl.empty();
    }

    await this.renderMessage(
      userMessage,
    );

    const requestStartedAt =
      performance.now();

    const streamingUi =
      this.createStreamingMessage(
        requestStartedAt,
      );

    this.activeStreamingUi =
      streamingUi;

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
                    info.sourceResolution ===
                    "current-question"
                  ) {
                    parts.push(
                      "source from current question",
                    );
                  } else if (
                    info.sourceResolution ===
                    "conversation-context"
                  ) {
                    parts.push(
                      "source from conversation context",
                    );
                  } else if (
                    info.sourceResolution ===
                    "unresolved"
                  ) {
                    parts.push(
                      "source unresolved",
                    );
                  }

                  if (
                    info.sourceConfidence !==
                    undefined
                  ) {
                    parts.push(
                      `source match ${Math.round(info.sourceConfidence)}%`,
                    );
                  }

                  if (
                    info.generationMode &&
                    info.generationModel
                  ) {
                    parts.push(
                      info.generationMode ===
                        "lecture"
                        ? `lecture model ${info.generationModel}`
                        : `chat model ${info.generationModel}`,
                    );
                  }

                  if (
                    info.section
                  ) {
                    const sectionText =
                      info.sectionTitle
                        ? `section ${info.section} — ${info.sectionTitle}`
                        : `section ${info.section}`;

                    parts.push(
                      info.mode ===
                        "section"
                        ? `exact ${sectionText}`
                        : sectionText,
                    );
                  }

                  if (
                    info.sourceSuggestions &&
                    info.sourceSuggestions
                      .length > 0
                  ) {
                    parts.push(
                      `possible source: ${info.sourceSuggestions.join(", ")}`,
                    );
                  }

                  if (
                    info.detectedSections &&
                    info.detectedSections
                      .length > 0
                  ) {
                    const preview =
                      info.detectedSections
                        .slice(
                          0,
                          8,
                        )
                        .join(", ");

                    parts.push(
                      `detected sections: ${preview}`,
                    );
                  }

                  parts.push(
                    `${info.chunkCount} chunk${info.chunkCount === 1 ? "" : "s"}`,
                  );

                  parts.push(
                    `${info.contextCharacters.toLocaleString()} chars`,
                  );

                  const prefix =
                    info.blockedReason
                      ? "Retrieval stopped"
                      : "Retrieved";

                  streamingUi
                    .status
                    .setText(
                      `${prefix} · ${parts.join(" · ")}…`,
                    );

                  streamingUi
                    .status
                    .addClass(
                      "is-working",
                    );

                  this.scrollToBottom();
                },

              onSources:
                (sources) => {
                  latestSources = [
                    ...sources,
                  ];
                },

              onTimings:
                (timings) => {
                  this.applyStageTimings(
                    streamingUi,
                    timings,
                  );
                },

              onThinking:
                (thinking) => {
                  latestThinking =
                    thinking;

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
                  latestAnswer =
                    answer;

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

            requestController
              .signal,
          );

      const generationDurationMs =
        this.stopStreamingTimer(
          streamingUi,
        );

      streamingUi.status
        .removeClass(
          "is-working",
        );

      streamingUi.status.setText(
        "Complete",
      );

      /*
       * The request succeeded. Commit the pending
       * user message first, then the assistant reply,
       * so saved history remains a complete turn.
       */
      this.currentConversation =
        await this.localPlugin
          .conversationStore
          .appendMessage(
            this
              .currentConversation,
            userMessage,
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
            this.toConversationSources(
              result.sources,
            ),

          generationDurationMs,

          stageTimings:
            this.copyStageTimings(
              streamingUi
                .stageTimings,
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
      const generationDurationMs =
        this.stopStreamingTimer(
          streamingUi,
        );

      const cancelled =
        requestController
          .signal
          .aborted;

      if (cancelled) {
        streamingUi.status
          .removeClass(
            "is-working",
            "is-error",
          );

        streamingUi.status
          .setText(
            "Stopped",
          );

        /*
         * Save an intentionally cancelled turn rather
         * than treating it as a failed transaction.
         *
         * Partial reasoning/answer text and already
         * retrieved citations are preserved.
         */
        const stoppedUserMessage:
          ConversationMessage = {
          ...userMessage,

          requestState:
            "stopped",
        };

        this.currentConversation =
          await this.localPlugin
            .conversationStore
            .appendMessage(
              this
                .currentConversation,
              stoppedUserMessage,
            );

        const partialContent =
          latestAnswer
            .trim();

        const stoppedContent =
          partialContent.length > 0
            ? `${partialContent}\n\n*Generation stopped.*`
            : "Generation stopped before an answer was produced.";

        const assistantMessage:
          ConversationMessage = {
          id:
            crypto.randomUUID(),

          role:
            "assistant",

          content:
            stoppedContent,

          thinking:
            latestThinking
              .trim()
              .length > 0
              ? latestThinking
              : undefined,

          createdAt:
            new Date()
              .toISOString(),

          sources:
            this.toConversationSources(
              latestSources,
            ),

          requestState:
            "stopped",

          generationDurationMs,

          stageTimings:
            this.copyStageTimings(
              streamingUi
                .stageTimings,
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

        await this
          .renderConversation();

        return;
      }

      const errorMessage =
        this.describeRequestError(
          error,
        );

      const partialAnswer =
        latestAnswer
          .trim();

      const failureContent =
        this.makeFailureMessage(
          errorMessage,
          partialAnswer,
        );

      console.error(
        "[Local Vault AI] Chat request failed.",
        error,
      );

      /*
       * Render the exact error into the active chat card
       * BEFORE attempting to persist it.
       *
       * This guarantees that model/streaming errors are
       * visible in the Local Vault AI conversation even
       * if saving the failed turn has a secondary error.
       */
      await this
        .renderFailureIntoStreamingUi(
          streamingUi,
          failureContent,
        );

      const failedUserMessage:
        ConversationMessage = {
        ...userMessage,

        requestState:
          "error",
      };

      const failedAssistantMessage:
        ConversationMessage = {
        id:
          crypto.randomUUID(),

        role:
          "assistant",

        content:
          failureContent,

        thinking:
          latestThinking
            .trim()
            .length > 0
            ? latestThinking
            : undefined,

        createdAt:
          new Date()
            .toISOString(),

        sources:
          this.toConversationSources(
            latestSources,
          ),

        requestState:
          "error",

        errorMessage,

        generationDurationMs,

        stageTimings:
          this.copyStageTimings(
            streamingUi
              .stageTimings,
          ),
      };

      try {
        this.currentConversation =
          await this.localPlugin
            .conversationStore
            .appendMessage(
              this
                .currentConversation,
              failedUserMessage,
            );

        this.currentConversation =
          await this.localPlugin
            .conversationStore
            .appendMessage(
              this
                .currentConversation,
              failedAssistantMessage,
            );

        /*
         * Only replace the active error card with the
         * persisted conversation after BOTH messages
         * have been successfully saved.
         */
        await this
          .renderConversation();
      } catch (
        persistenceError
      ) {
        console.error(
          "[Local Vault AI] Could not persist failed chat request.",
          persistenceError,
        );

        const persistenceMessage =
          this.describeRequestError(
            persistenceError,
          );

        const safePersistenceMessage =
          persistenceMessage.replace(
            /```/g,
            "'''",
          );

        const combinedFailure =
          [
            failureContent,
            "",
            "**Conversation persistence also failed**",
            "",
            "```text",
            safePersistenceMessage,
            "```",
            "",
            "The original request error remains visible in this chat card, but this failed turn may not survive an Obsidian/plugin reload because the conversation store could not be written.",
          ].join(
            "\n",
          );

        await this
          .renderFailureIntoStreamingUi(
            streamingUi,
            combinedFailure,
          );
      }

      /*
       * Keep the original question ready for an explicit
       * retry. Failed turns are filtered from future RAG
       * context, so the saved diagnostic copy will not
       * contaminate the next request.
       *
       * Deliberately do NOT show an Obsidian Notice here.
       * The in-chat error record is now the primary error
       * surface.
       */
      this.inputEl.value =
        question;
    } finally {
      if (
        this.activeRequestController ===
        requestController
      ) {
        this.activeRequestController =
          null;
      }

      if (
        this.activeStreamingUi ===
        streamingUi
      ) {
        this.activeStreamingUi =
          null;
      }

      this.setRequestControls(
        false,
      );

      this.inputEl.focus();
    }
  }

  private stopActiveRequest(
    updateUi:
      boolean,
  ): void {
    const controller =
      this.activeRequestController;

    if (
      !controller ||
      controller.signal
        .aborted
    ) {
      return;
    }

    if (
      this.activeStreamingUi
    ) {
      this.stopStreamingTimer(
        this.activeStreamingUi,
      );
    }

    if (
      updateUi &&
      this.activeStreamingUi
    ) {
      this.activeStreamingUi
        .status
        .removeClass(
          "is-error",
        );

      this.activeStreamingUi
        .status
        .addClass(
          "is-working",
        );

      this.activeStreamingUi
        .status
        .setText(
          "Stopping…",
        );
    }

    if (
      this.stopButton
    ) {
      this.stopButton.disabled =
        true;

      this.stopButton.setText(
        "Stopping…",
      );
    }

    controller.abort();
  }

  private setRequestControls(
    active:
      boolean,
  ): void {
    if (
      this.askButton
    ) {
      this.askButton.disabled =
        active;

      this.askButton.setText(
        active
          ? "Working…"
          : "Ask",
      );
    }

    if (
      this.stopButton
    ) {
      this.stopButton.disabled =
        !active;

      this.stopButton.setText(
        "Stop",
      );
    }
  }

  private toConversationSources(
    sources:
      RetrievedChunk[],
  ): ConversationSource[] {
    return sources.map(
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

        sectionNumber:
          source.sectionNumber,

        sectionTitle:
          source.sectionTitle,
      }),
    );
  }

  private applyStageTimings(
    ui:
      StreamingMessageUi,

    timings:
      RagStageTimings,
  ): void {
    ui.stageTimings = {
      ...ui.stageTimings,
      ...timings,
    };

    this.updateStageTimingsDisplay(
      ui,
    );
  }

  private finalizeStageTransition(
    ui:
      StreamingMessageUi,

    nextStage:
      RagStreamStage,

    now:
      number,
  ): void {
    if (
      ui.currentStage ===
      nextStage
    ) {
      return;
    }

    this.finalizeActiveStage(
      ui,
      now,
    );

    ui.currentStage =
      nextStage;

    ui.stageStartedAt =
      now;
  }

  private finalizeActiveStage(
    ui:
      StreamingMessageUi,

    now:
      number,
  ): void {
    const elapsed =
      Math.max(
        0,
        now -
          ui.stageStartedAt,
      );

    if (
      ui.currentStage ===
        "retrieving" &&
      ui.stageTimings
        .retrievalMs ===
        undefined
    ) {
      ui.stageTimings
        .retrievalMs =
        elapsed;

      return;
    }

    if (
      ui.currentStage ===
        "thinking" &&
      ui.stageTimings
        .reasoningMs ===
        undefined
    ) {
      ui.stageTimings
        .reasoningMs =
        elapsed;

      return;
    }

    if (
      ui.currentStage ===
        "answering" &&
      ui.stageTimings
        .answeringMs ===
        undefined
    ) {
      ui.stageTimings
        .answeringMs =
        elapsed;
    }
  }

  private updateStageTimingsDisplay(
    ui:
      StreamingMessageUi,
  ): void {
    const snapshot:
      RagStageTimings = {
      ...ui.stageTimings,
    };

    const liveElapsed =
      Math.max(
        0,
        performance.now() -
          ui.stageStartedAt,
      );

    if (
      ui.finalElapsedMs ===
        null
    ) {
      if (
        ui.currentStage ===
          "retrieving" &&
        snapshot
          .retrievalMs ===
          undefined
      ) {
        snapshot.retrievalMs =
          liveElapsed;
      }

      if (
        ui.currentStage ===
          "thinking" &&
        snapshot
          .reasoningMs ===
          undefined
      ) {
        snapshot.reasoningMs =
          liveElapsed;
      }

      if (
        ui.currentStage ===
          "answering" &&
        snapshot
          .answeringMs ===
          undefined
      ) {
        snapshot.answeringMs =
          liveElapsed;
      }
    }

    ui.timingsEl.setText(
      this.formatStageTimings(
        snapshot,
        ui.currentStage ===
          "model" &&
        ui.finalElapsedMs ===
          null,
      ),
    );
  }

  private formatStageTimings(
    timings:
      RagStageTimings,

    modelStageActive =
      false,
  ): string {
    const modelMetric = (
      value:
        number | undefined,
    ): string =>
      value !==
        undefined
        ? this.formatStageDuration(
            value,
          )
        : modelStageActive
          ? "measuring…"
          : "—";

    return (
      `Retrieval: ${this.formatStageDuration(
        timings.retrievalMs,
      )} · ` +
      `Model startup: ${modelMetric(
        timings.modelStartupMs,
      )} · ` +
      `Prompt processing: ${modelMetric(
        timings.promptProcessingMs,
      )} · ` +
      `Reasoning: ${this.formatStageDuration(
        timings.reasoningMs,
      )} · ` +
      `Answering: ${this.formatStageDuration(
        timings.answeringMs,
      )}`
    );
  }

  private formatStageDuration(
    value:
      number | undefined,
  ): string {
    if (
      value ===
        undefined ||
      !Number.isFinite(
        value,
      )
    ) {
      return "—";
    }

    return (
      `${(
        Math.max(
          0,
          value,
        ) /
        1000
      ).toFixed(1)}s`
    );
  }

  private copyStageTimings(
    timings:
      RagStageTimings,
  ): RagStageTimings {
    return {
      ...timings,
    };
  }

  private updateStreamingTimer(
    ui:
      StreamingMessageUi,
  ): void {
    const elapsedMs =
      ui.finalElapsedMs ??
      Math.max(
        0,
        performance.now() -
          ui.startedAt,
      );

    ui.role.setText(
      `Local Vault AI · ${this.formatElapsedTime(
        elapsedMs,
      )}`,
    );

    this.updateStageTimingsDisplay(
      ui,
    );
  }

  private stopStreamingTimer(
    ui:
      StreamingMessageUi,
  ): number {
    /*
     * Idempotent: completion, the Stop button, catch,
     * and DOM removal can all converge on the same
     * streaming card.
     */
    if (
      ui.finalElapsedMs !==
      null
    ) {
      return ui.finalElapsedMs;
    }

    const now =
      performance.now();

    this.finalizeActiveStage(
      ui,
      now,
    );

    const elapsedMs =
      Math.max(
        0,
        now -
          ui.startedAt,
      );

    ui.finalElapsedMs =
      Math.round(
        elapsedMs,
      );

    if (
      ui.timerIntervalId !==
      null
    ) {
      window.clearInterval(
        ui.timerIntervalId,
      );

      ui.timerIntervalId =
        null;
    }

    this.updateStreamingTimer(
      ui,
    );

    return ui.finalElapsedMs;
  }

  private formatElapsedTime(
    elapsedMs:
      number,
  ): string {
    const totalSeconds =
      Math.max(
        0,
        Math.floor(
          elapsedMs /
          1000,
        ),
      );

    const hours =
      Math.floor(
        totalSeconds /
        3600,
      );

    const minutes =
      Math.floor(
        (
          totalSeconds %
          3600
        ) /
        60,
      );

    const seconds =
      totalSeconds %
      60;

    const secondsText =
      String(
        seconds,
      ).padStart(
        2,
        "0",
      );

    const minutesText =
      String(
        minutes,
      ).padStart(
        2,
        "0",
      );

    if (
      hours <=
      0
    ) {
      return (
        `${minutesText}:` +
        secondsText
      );
    }

    return (
      `${String(hours).padStart(
        2,
        "0",
      )}:` +
      `${minutesText}:` +
      secondsText
    );
  }

  private async renderFailureIntoStreamingUi(
    ui:
      StreamingMessageUi,

    content:
      string,
  ): Promise<void> {
    ui.status
      .removeClass(
        "is-working",
      );

    ui.status
      .addClass(
        "is-error",
      );

    ui.status
      .setText(
        "Request failed — details below",
      );

    /*
     * Preserve any reasoning that already streamed, but
     * replace the answer area with the exact failure
     * diagnostic.
     */
    ui.answerBody.empty();

    await MarkdownRenderer
      .render(
        this.app,
        content,
        ui.answerBody,
        "",
        this,
      );

    ui.answerBody.dataset
      .copyText =
        content;

    ui.copyButton.disabled =
      false;

    this.scrollToBottom();
  }

  private describeRequestError(
    error:
      unknown,
  ): string {
    if (
      error instanceof
      Error
    ) {
      const name =
        error.name &&
        error.name !==
          "Error"
          ? `${error.name}: `
          : "";

      const message =
        error.message
          .trim();

      return (
        name +
        (
          message ||
          "Local Vault AI request failed."
        )
      );
    }

    const text =
      String(
        error,
      )
        .trim();

    return (
      text ||
      "Local Vault AI request failed."
    );
  }

  private makeFailureMessage(
    errorMessage:
      string,

    partialAnswer:
      string,
  ): string {
    const safeError =
      errorMessage.replace(
        /```/g,
        "'''",
      );

    const sections:
      string[] = [
      "**Request failed.**",
      "",
      "The request did not complete. The error has been saved here so it can be reviewed later.",
      "",
      "**Error**",
      "",
      "```text",
      safeError,
      "```",
    ];

    if (
      partialAnswer.length >
      0
    ) {
      sections.push(
        "",
        "**Partial response before the failure**",
        "",
        partialAnswer,
      );
    }

    return sections.join(
      "\n",
    );
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
