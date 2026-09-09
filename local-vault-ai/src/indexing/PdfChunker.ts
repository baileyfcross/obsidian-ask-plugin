import type {
  PdfPageText,
} from "./PdfExtractor";

export interface PdfChunk {
  heading: string;

  /*
   * Explicit numbered-section metadata.
   *
   * Example:
   *   sectionNumber: "1.5"
   *   sectionTitle: "Deduction"
   */
  sectionNumber: string;
  sectionTitle: string;

  content: string;
  index: number;
  pageStart: number;
  pageEnd: number;
}

interface DetectedSection {
  number: string;
  title: string;
  consumedLines: number;
}

const TARGET_CHARS = 2800;
const HARD_MAX_CHARS = 4200;

export function chunkPdfPages(
  pages: PdfPageText[],
): PdfChunk[] {
  const chunks:
    PdfChunk[] = [];

  let currentHeading =
    "Document";

  let currentSectionNumber =
    "";

  let currentSectionTitle =
    "";

  let buffer:
    string[] = [];

  let bufferChars = 0;

  let pageStart = 0;
  let pageEnd = 0;

  let chunkIndex = 0;

  const flush =
    (): void => {
      const content =
        buffer
          .join("\n")
          .trim();

      if (!content) {
        resetBuffer();
        return;
      }

      chunks.push({
        heading:
          currentHeading,

        sectionNumber:
          currentSectionNumber,

        sectionTitle:
          currentSectionTitle,

        content,

        index:
          chunkIndex,

        pageStart,
        pageEnd,
      });

      chunkIndex += 1;

      resetBuffer();
    };

  const resetBuffer =
    (): void => {
      buffer = [];
      bufferChars = 0;
      pageStart = 0;
      pageEnd = 0;
    };

  const appendLine = (
    line: string,
    pageNumber: number,
  ): void => {
    if (pageStart === 0) {
      pageStart =
        pageNumber;
    }

    pageEnd =
      pageNumber;

    buffer.push(line);

    bufferChars +=
      line.length + 1;
  };

  for (const page of pages) {
    const lines =
      page.lines
        .map(
          (line) =>
            normalizeLine(line),
        )
        .filter(Boolean);

    for (
      let lineIndex = 0;
      lineIndex <
      lines.length;
      lineIndex += 1
    ) {
      const line =
        lines[lineIndex];

      if (!line) {
        continue;
      }

      const section =
        detectSection(
          lines,
          lineIndex,
        );

      if (section) {
        /*
         * A repeated running header such as:
         *
         *   1.5. DEDUCTION
         *
         * on the next PDF page should NOT create a
         * new section or tiny empty chunk.
         */
        if (
          section.number ===
          currentSectionNumber
        ) {
          if (
            !currentSectionTitle &&
            section.title
          ) {
            currentSectionTitle =
              section.title;

            currentHeading =
              makeSectionHeading(
                section.number,
                section.title,
              );
          }

          lineIndex +=
            section
              .consumedLines -
            1;

          continue;
        }

        flush();

        currentSectionNumber =
          section.number;

        currentSectionTitle =
          section.title;

        currentHeading =
          makeSectionHeading(
            section.number,
            section.title,
          );

        /*
         * Store a canonical heading in the content
         * as well as metadata. This remains useful
         * for embeddings and ordinary lexical search.
         */
        appendLine(
          currentHeading,
          page.pageNumber,
        );

        lineIndex +=
          section
            .consumedLines -
          1;

        continue;
      }

      const chapter =
        detectChapterHeading(
          line,
        );

      if (chapter) {
        flush();

        currentSectionNumber =
          "";

        currentSectionTitle =
          "";

        currentHeading =
          chapter;

        appendLine(
          chapter,
          page.pageNumber,
        );

        continue;
      }

      const genericHeading =
        detectGenericHeading(
          line,
        );

      if (genericHeading) {
        /*
         * Generic subheadings do not clear a numbered
         * section. Chunks remain filterable by their
         * parent sectionNumber.
         */
        flush();

        currentHeading =
          genericHeading;

        appendLine(
          genericHeading,
          page.pageNumber,
        );

        continue;
      }

      if (
        bufferChars > 0 &&
        bufferChars +
          line.length +
          1 >
          HARD_MAX_CHARS
      ) {
        flush();
      }

      appendLine(
        line,
        page.pageNumber,
      );

      if (
        bufferChars >=
        TARGET_CHARS
      ) {
        flush();
      }
    }
  }

  flush();

  return chunks;
}

function detectSection(
  lines: string[],
  index: number,
): DetectedSection | null {
  const line =
    lines[index];

  if (
    !line ||
    looksLikeTableOfContentsEntry(
      line,
    )
  ) {
    return null;
  }

  const sameLine =
    parseNumberAndTitle(
      line,
    );

  if (sameLine) {
    return {
      ...sameLine,
      consumedLines: 1,
    };
  }

  const numberOnly =
    parseNumberOnly(
      line,
    );

  if (numberOnly) {
    const next =
      lines[
        index + 1
      ];

    if (
      next &&
      isPlausibleSectionTitle(
        next,
      )
    ) {
      return {
        number:
          numberOnly,
        title:
          cleanSectionTitle(
            next,
          ),
        consumedLines: 2,
      };
    }
  }

  /*
   * Some PDFs split:
   *
   *   1.
   *   5
   *   Deduction
   *
   * into separate positioned text lines.
   */
  const majorOnly =
    line.match(
      /^(\d+)\.\s*$/,
    );

  if (majorOnly?.[1]) {
    const second =
      lines[
        index + 1
      ];

    const third =
      lines[
        index + 2
      ];

    const secondNumber =
      second?.match(
        /^(\d+)\.?\s*$/,
      );

    if (
      secondNumber?.[1] &&
      third &&
      isPlausibleSectionTitle(
        third,
      )
    ) {
      return {
        number:
          `${majorOnly[1]}.${secondNumber[1]}`,

        title:
          cleanSectionTitle(
            third,
          ),

        consumedLines: 3,
      };
    }

    const secondWithTitle =
      second?.match(
        /^(\d+)\.?\s+(.+)$/,
      );

    if (
      secondWithTitle?.[1] &&
      secondWithTitle[2] &&
      isPlausibleSectionTitle(
        secondWithTitle[2],
      )
    ) {
      return {
        number:
          `${majorOnly[1]}.${secondWithTitle[1]}`,

        title:
          cleanSectionTitle(
            secondWithTitle[2],
          ),

        consumedLines: 2,
      };
    }
  }

  return null;
}

function parseNumberAndTitle(
  line: string,
): {
  number: string;
  title: string;
} | null {
  const match =
    line.match(
      /^(?:section\s+)?(\d+(?:\s*\.\s*\d+){1,4})\.?\s+(.+)$/i,
    );

  if (
    !match?.[1] ||
    !match[2]
  ) {
    return null;
  }

  const title =
    cleanSectionTitle(
      match[2],
    );

  if (
    !isPlausibleSectionTitle(
      title,
    )
  ) {
    return null;
  }

  if (
    looksLikeTableOfContentsEntry(
      line,
    )
  ) {
    return null;
  }

  return {
    number:
      normalizeSectionNumber(
        match[1],
      ),
    title,
  };
}

function parseNumberOnly(
  line: string,
): string | null {
  const match =
    line.match(
      /^(?:section\s+)?(\d+(?:\s*\.\s*\d+){1,4})\.?\s*$/i,
    );

  return match?.[1]
    ? normalizeSectionNumber(
        match[1],
      )
    : null;
}

function normalizeSectionNumber(
  value: string,
): string {
  return value
    .replace(
      /\s+/g,
      "",
    )
    .replace(
      /\.$/,
      "",
    );
}

function cleanSectionTitle(
  value: string,
): string {
  return value
    .replace(
      /\s+/g,
      " ",
    )
    .replace(
      /^\s*[-–—:]\s*/,
      "",
    )
    .trim();
}

function isPlausibleSectionTitle(
  value: string,
): boolean {
  const title =
    cleanSectionTitle(
      value,
    );

  if (
    title.length === 0 ||
    title.length > 160
  ) {
    return false;
  }

  if (
    looksLikeTableOfContentsEntry(
      title,
    )
  ) {
    return false;
  }

  if (
    title
      .split(/\s+/)
      .length > 18
  ) {
    return false;
  }

  /*
   * A trailing page number is a strong TOC signal:
   * "Deduction 33".
   */
  if (
    /\s\d{1,4}$/.test(
      title,
    )
  ) {
    return false;
  }

  /*
   * Avoid ordinary prose such as:
   * "1.5 volts are applied."
   *
   * Textbook headings are normally title-case,
   * uppercase, or begin with a digit/symbol.
   */
  const firstLetter =
    title.match(
      /\p{L}/u,
    )?.[0];

  if (
    firstLetter &&
    firstLetter ===
      firstLetter.toLowerCase() &&
    firstLetter !==
      firstLetter.toUpperCase()
  ) {
    return false;
  }

  if (
    /[.!?]$/.test(
      title,
    ) &&
    title !==
      title.toUpperCase()
  ) {
    return false;
  }

  return true;
}

function looksLikeTableOfContentsEntry(
  line: string,
): boolean {
  return (
    /\.{3,}\s*\d{1,4}\s*$/.test(
      line,
    ) ||
    /…{2,}\s*\d{1,4}\s*$/.test(
      line,
    )
  );
}

function detectChapterHeading(
  line: string,
): string | null {
  const match =
    line.match(
      /^(chapter\s+(?:\d+|[ivxlcdm]+)\b.{0,160})$/i,
    );

  return match?.[1]
    ? match[1].trim()
    : null;
}

function detectGenericHeading(
  line: string,
): string | null {
  if (
    line.length < 4 ||
    line.length > 100
  ) {
    return null;
  }

  if (
    looksLikeTableOfContentsEntry(
      line,
    )
  ) {
    return null;
  }

  if (
    /[A-Z]/.test(line) &&
    line ===
      line.toUpperCase() &&
    !/[.!?]$/.test(
      line,
    )
  ) {
    return line;
  }

  return null;
}

function makeSectionHeading(
  number: string,
  title: string,
): string {
  return title
    ? `${number} ${title}`
    : `Section ${number}`;
}

function normalizeLine(
  value: string,
): string {
  return value
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}
