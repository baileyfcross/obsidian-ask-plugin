import {
  App,
  Keymap,
  Notice,
  TFile,
} from "obsidian";
import type {
  ConversationSource,
} from "../types";

export interface SourceNavigationTarget {
  linkText: string;
  description: string;
}

/**
 * Opens persisted RAG citations at the most precise
 * location currently stored in ConversationSource.
 *
 * PDF:
 *   file.pdf#page=36
 *
 * Markdown:
 *   note.md#Heading
 *
 * The PDF page number is the one-based PHYSICAL page
 * number recorded by PDF.js during indexing. This is
 * the page number Obsidian's PDF viewer expects, even
 * when the printed page number inside the book differs.
 */
export class SourceNavigator {
  constructor(
    private readonly app:
      App,
  ) {}

  buildTarget(
    source:
      ConversationSource,
  ): SourceNavigationTarget {
    const filePath =
      source.filePath;

    if (
      this.isPdfSource(
        source,
      )
    ) {
      const page =
        this.validPdfPage(
          source.pageStart,
        );

      if (page) {
        return {
          linkText:
            `${filePath}#page=${page}`,

          description:
            `Open ${filePath} at PDF page ${page}`,
        };
      }

      return {
        linkText:
          filePath,

        description:
          `Open ${filePath}`,
      };
    }

    const heading =
      this.markdownHeading(
        source,
      );

    if (heading) {
      return {
        linkText:
          `${filePath}#${heading}`,

        description:
          `Open ${filePath} at heading "${heading}"`,
      };
    }

    return {
      linkText:
        filePath,

      description:
        `Open ${filePath}`,
    };
  }

  /**
   * Primary navigation path.
   *
   * Workspace.openLinkText() understands Obsidian
   * subpaths such as:
   *
   *   #page=36
   *   #A Markdown Heading
   *
   * and therefore provides more precise navigation
   * than WorkspaceLeaf.openFile(file) by itself.
   */
  async open(
    source:
      ConversationSource,

    event?:
      MouseEvent,
  ): Promise<void> {
    const file =
      this.app.vault
        .getAbstractFileByPath(
          source.filePath,
        );

    if (
      !(file instanceof
        TFile)
    ) {
      new Notice(
        `Source file is no longer available: ${source.filePath}`,
      );

      return;
    }

    const target =
      this.buildTarget(
        source,
      );

    const openInNewLeaf =
      event
        ? this.shouldOpenInNewLeaf(
            event,
          )
        : false;

    try {
      /*
       * Use a root-relative vault path as linkText and
       * an empty source path. This mirrors Obsidian's
       * documented plugin-navigation pattern.
       */
      await this.app
        .workspace
        .openLinkText(
          target.linkText,
          "",
          openInNewLeaf,
        );
    } catch (error) {
      console.error(
        "[Local Vault AI] Precise source navigation failed.",
        {
          source,
          target,
          error,
        },
      );

      /*
       * Graceful fallback: still open the file if
       * Obsidian rejects the page/heading subpath.
       */
      try {
        await this.app
          .workspace
          .getLeaf(
            openInNewLeaf,
          )
          .openFile(
            file,
          );

        new Notice(
          "Opened the source, but Obsidian could not jump to the cited location.",
        );
      } catch (
        fallbackError
      ) {
        console.error(
          "[Local Vault AI] Source fallback navigation failed.",
          fallbackError,
        );

        new Notice(
          `Could not open source: ${source.filePath}`,
        );
      }
    }
  }

  /**
   * Support Ctrl/Cmd-click and middle-click as
   * "open in new tab/leaf" gestures.
   *
   * Shift is also treated as a request not to replace
   * the current editor leaf.
   */
  private shouldOpenInNewLeaf(
    event:
      MouseEvent,
  ): boolean {
    return (
      Boolean(
        Keymap.isModEvent(
          event,
        ),
      ) ||
      event.button ===
        1 ||
      event.shiftKey
    );
  }

  private isPdfSource(
    source:
      ConversationSource,
  ): boolean {
    return (
      source.sourceType ===
        "pdf" ||
      source.filePath
        .toLowerCase()
        .endsWith(
          ".pdf",
        )
    );
  }

  private validPdfPage(
    value:
      number | undefined,
  ): number | null {
    if (
      value ===
        undefined ||
      !Number.isFinite(
        value,
      ) ||
      value <= 0
    ) {
      return null;
    }

    return Math.max(
      1,
      Math.floor(
        value,
      ),
    );
  }

  /**
   * Markdown chunks already persist `heading`.
   *
   * Older conversations may not have newer section
   * metadata, so heading remains the most compatible
   * precise Markdown target.
   */
  private markdownHeading(
    source:
      ConversationSource,
  ): string | null {
    const heading =
      source.heading
        ?.trim();

    if (heading) {
      return heading;
    }

    /*
     * If a future Markdown index stores numbered
     * sections without `heading`, sectionTitle is a
     * useful fallback.
     */
    const sectionTitle =
      source.sectionTitle
        ?.trim();

    return sectionTitle ||
      null;
  }
}
