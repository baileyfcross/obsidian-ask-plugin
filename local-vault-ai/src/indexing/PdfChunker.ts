import {
  PdfPageText,
} from "./PdfExtractor";

export interface PdfChunk {
  heading: string;
  content: string;
  index: number;
  pageStart: number;
  pageEnd: number;
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
        buffer = [];
        bufferChars = 0;
        pageStart = 0;
        pageEnd = 0;
        return;
      }

      chunks.push({
        heading:
          currentHeading,
        content,
        index:
          chunkIndex,
        pageStart,
        pageEnd,
      });

      chunkIndex += 1;
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
    for (
      const rawLine of
      page.lines
    ) {
      const line =
        rawLine.trim();

      if (!line) {
        continue;
      }

      const heading =
        detectPdfHeading(
          line,
        );

      if (heading) {
        flush();

        currentHeading =
          heading;

        /*
         * Keep the printed heading in content too.
         * This improves exact lexical search for
         * queries such as "section 1.5".
         */
        appendLine(
          line,
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

      /*
       * Prefer page boundaries for a natural chunk
       * break once the target size has been reached.
       */
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

function detectPdfHeading(
  line: string,
): string | null {
  /*
   * Examples:
   *   1.5 Boolean Algebra
   *   1.5. Boolean Algebra
   *   Section 1.5 Boolean Algebra
   *   3.2.4 A Smaller Heading
   */
  const numbered =
    line.match(
      /^(?:section\s+)?(\d+(?:\.\d+){1,4})\.?\s*(.*)$/i,
    );

  if (numbered) {
    const number =
      numbered[1];

    const rest =
      numbered[2]
        ?.trim() ?? "";

    if (
      number &&
      rest.length <= 180
    ) {
      return rest
        ? `${number} ${rest}`
        : `Section ${number}`;
    }
  }

  const chapter =
    line.match(
      /^(chapter\s+(?:\d+|[ivxlcdm]+)\b.{0,160})$/i,
    );

  if (chapter?.[1]) {
    return chapter[1]
      .trim();
  }

  /*
   * Short all-uppercase lines are often textbook
   * section headings. Keep this conservative to
   * avoid treating ordinary sentences as headings.
   */
  if (
    line.length >= 4 &&
    line.length <= 100 &&
    /[A-Z]/.test(line) &&
    line ===
      line.toUpperCase() &&
    !/[.!?]$/.test(line)
  ) {
    return line;
  }

  return null;
}
