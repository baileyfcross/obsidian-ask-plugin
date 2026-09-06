export interface MarkdownChunk {
  heading: string;
  content: string;
  index: number;
}

const TARGET_CHARS = 2800;
const HARD_MAX_CHARS = 4200;

export function chunkMarkdown(markdown: string): MarkdownChunk[] {
  const cleaned = stripFrontmatter(markdown);
  const lines = cleaned.split(/\r?\n/);

  const chunks: MarkdownChunk[] = [];
  const headingStack: string[] = [];

  let buffer: string[] = [];
  let chunkIndex = 0;
  let inFence = false;

  const currentHeading = (): string => {
    const parts = headingStack.filter(
      (value): value is string => Boolean(value),
    );

    return parts.length > 0
      ? parts.join(" > ")
      : "Document";
  };

  const flush = (): void => {
    const text = buffer.join("\n").trim();

    if (!text) {
      buffer = [];
      return;
    }

    chunks.push({
      heading: currentHeading(),
      content: text,
      index: chunkIndex,
    });

    chunkIndex += 1;
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    if (!inFence) {
      const headingMatch = line.match(
        /^(#{1,6})\s+(.+?)\s*#*\s*$/,
      );

      if (headingMatch) {
        flush();

        const hashes = headingMatch[1];
        const headingText = headingMatch[2];

        if (hashes && headingText) {
          const level = hashes.length;
          headingStack.length = level - 1;
          headingStack[level - 1] = headingText.trim();
        }

        continue;
      }
    }

    const prospectiveLength =
      buffer.join("\n").length + line.length + 1;

    if (
      buffer.length > 0 &&
      prospectiveLength > HARD_MAX_CHARS
    ) {
      flush();
    }

    buffer.push(line);

    if (
      buffer.join("\n").length >= TARGET_CHARS &&
      line.trim() === ""
    ) {
      flush();
    }
  }

  flush();
  return chunks;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return normalized;
  }

  const end = normalized.indexOf("\n---\n", 4);

  if (end === -1) {
    return normalized;
  }

  return normalized.slice(end + 5);
}
