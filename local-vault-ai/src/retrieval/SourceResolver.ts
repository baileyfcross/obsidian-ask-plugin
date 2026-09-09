import type {
  SourceType,
} from "../types";

export interface SourceCandidateDescriptor {
  filePath: string;
  fileName: string;
  title: string;
  sourceType: SourceType;
}

const STOP_WORDS =
  new Set([
    "a",
    "an",
    "and",
    "book",
    "file",
    "in",
    "my",
    "note",
    "of",
    "on",
    "pdf",
    "the",
  ]);

export function extractRequestedSourcePhrase(
  question: string,
): string | null {
  /*
   * Prefer an explicit "what does X say/talk/cover"
   * shape when present.
   */
  const direct =
    question.match(
      /^\s*what\s+does\s+(?:(?:my|the)\s+(?:book|pdf|note|file)\s+)?(.+?)\s+(?:say|says|talk|talks|cover|covers|mention|mentions)\b/i,
    );

  if (direct?.[1]) {
    return cleanPhrase(
      direct[1],
    );
  }

  /*
   * Remove an explicit section suffix before the
   * generic cleanup. This keeps version numbers in
   * filenames from being mistaken for section ids.
   */
  const sectionMatch =
    question.match(
      /\b(?:section|sec\.?)\s+\d+(?:\.\d+){1,4}\b/i,
    ) ??
    question.match(
      /§\s*\d+(?:\.\d+){1,4}\b/i,
    );

  let working =
    sectionMatch?.index !==
    undefined
      ? question.slice(
          0,
          sectionMatch.index,
        )
      : question;

  working =
    working
      .replace(
        /[?!.]+$/g,
        "",
      )
      .trim();

  working =
    working.replace(
      /^\s*(?:what\s+does|what\s+do|what\s+is\s+in|according\s+to|from|in)\s+/i,
      "",
    );

  working =
    working.replace(
      /^\s*(?:(?:my|the)\s+)?(?:book|pdf|note|file)\s+/i,
      "",
    );

  /*
   * Remove a trailing action phrase:
   * "say for", "talk about", "cover", etc.
   */
  working =
    working.replace(
      /\s+(?:say|says|talk|talks|cover|covers|mention|mentions)\b.*$/i,
      "",
    );

  return cleanPhrase(
    working,
  );
}

export function buildSourceSearchTerms(
  question: string,
): string[] {
  const phrase =
    extractRequestedSourcePhrase(
      question,
    );

  if (!phrase) {
    return [];
  }

  const normalized =
    normalizeSourceName(
      phrase,
    );

  const terms =
    normalized
      .split(" ")
      .filter(
        (token) =>
          token.length >= 4 &&
          !STOP_WORDS.has(
            token,
          ),
      )
      .sort(
        (a, b) =>
          b.length -
          a.length,
      );

  return Array.from(
    new Set([
      normalized,
      ...terms.slice(0, 5),
    ]),
  );
}

export function scoreSourceCandidate(
  question: string,
  candidate:
    SourceCandidateDescriptor,
): number {
  const phrase =
    extractRequestedSourcePhrase(
      question,
    );

  if (!phrase) {
    return 0;
  }

  const requested =
    normalizeSourceName(
      phrase,
    );

  const names = [
    candidate.title,
    candidate.fileName,
    candidate.filePath
      .split("/")
      .pop() ??
      candidate.filePath,
  ];

  let best = 0;

  for (const name of names) {
    const normalized =
      normalizeSourceName(
        name,
      );

    if (
      !normalized ||
      normalized.length < 4
    ) {
      continue;
    }

    if (
      requested === normalized
    ) {
      best =
        Math.max(
          best,
          100,
        );

      continue;
    }

    if (
      requested.includes(
        normalized,
      ) ||
      normalized.includes(
        requested,
      )
    ) {
      const shorter =
        Math.min(
          requested.length,
          normalized.length,
        );

      const longer =
        Math.max(
          requested.length,
          normalized.length,
        );

      best =
        Math.max(
          best,
          90 +
            (shorter /
              longer) *
              10,
        );
    }

    const edit =
      normalizedLevenshtein(
        requested,
        normalized,
      );

    const token =
      softTokenDice(
        requested,
        normalized,
      );

    const prefix =
      commonPrefixRatio(
        requested,
        normalized,
      );

    /*
     * Token matching treats long words with a
     * common six-character stem as equivalent.
     * This intentionally handles:
     *
     * computer / computation
     *
     * without requiring a model call to resolve
     * the source filename.
     */
    const blended =
      edit * 0.45 +
      token * 0.40 +
      prefix * 0.15;

    best =
      Math.max(
        best,
        edit * 100,
        blended * 100,
      );
  }

  return Math.min(
    100,
    best,
  );
}

export function normalizeSourceName(
  value: string,
): string {
  let working =
    value
      .replace(
        /([a-z0-9])([A-Z])/g,
        "$1 $2",
      )
      .replace(
        /\.(?:md|pdf)$/i,
        "",
      )
      .replace(
        /[_\\/\-]+/g,
        " ",
      )
      .normalize(
        "NFKD",
      )
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}. ]+/gu,
        " ",
      )
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  const tokens =
    working.split(" ");

  while (
    tokens.length > 1 &&
    isFileSuffixToken(
      tokens[
        tokens.length - 1
      ] ?? "",
    )
  ) {
    tokens.pop();
  }

  working =
    tokens.join(" ");

  return working;
}

function cleanPhrase(
  value: string,
): string | null {
  const cleaned =
    value
      .replace(
        /^[\s"'`]+|[\s"'`,:;]+$/g,
        "",
      )
      .trim();

  return cleaned.length >= 4
    ? cleaned
    : null;
}

function isFileSuffixToken(
  token: string,
): boolean {
  return (
    /^(?:v)?\d+(?:\.\d+)+$/i.test(
      token,
    ) ||
    /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/i.test(
      token,
    ) ||
    /^(?:final|copy|scan)$/i.test(
      token,
    )
  );
}

function softTokenDice(
  left: string,
  right: string,
): number {
  const leftTokens =
    significantTokens(
      left,
    );

  const rightTokens =
    significantTokens(
      right,
    );

  if (
    leftTokens.length === 0 ||
    rightTokens.length === 0
  ) {
    return 0;
  }

  const used =
    new Set<number>();

  let matches = 0;

  for (
    const leftToken of
    leftTokens
  ) {
    for (
      let index = 0;
      index <
      rightTokens.length;
      index += 1
    ) {
      if (
        used.has(index)
      ) {
        continue;
      }

      const rightToken =
        rightTokens[index];

      if (
        rightToken &&
        tokensEquivalent(
          leftToken,
          rightToken,
        )
      ) {
        used.add(index);
        matches += 1;
        break;
      }
    }
  }

  return (
    (2 * matches) /
    (leftTokens.length +
      rightTokens.length)
  );
}

function significantTokens(
  value: string,
): string[] {
  return value
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 &&
        !STOP_WORDS.has(
          token,
        ),
    );
}

function tokensEquivalent(
  left: string,
  right: string,
): boolean {
  if (left === right) {
    return true;
  }

  if (
    left.length >= 6 &&
    right.length >= 6
  ) {
    return (
      left.slice(0, 6) ===
      right.slice(0, 6)
    );
  }

  return false;
}

function commonPrefixRatio(
  left: string,
  right: string,
): number {
  const maximum =
    Math.min(
      left.length,
      right.length,
    );

  let common = 0;

  while (
    common < maximum &&
    left[common] ===
      right[common]
  ) {
    common += 1;
  }

  return maximum === 0
    ? 0
    : common / maximum;
}

function normalizedLevenshtein(
  left: string,
  right: string,
): number {
  if (left === right) {
    return 1;
  }

  if (
    left.length === 0 ||
    right.length === 0
  ) {
    return 0;
  }

  const previous =
    new Array<number>(
      right.length + 1,
    );

  const current =
    new Array<number>(
      right.length + 1,
    );

  for (
    let column = 0;
    column <=
    right.length;
    column += 1
  ) {
    previous[column] =
      column;
  }

  for (
    let row = 1;
    row <= left.length;
    row += 1
  ) {
    current[0] = row;

    for (
      let column = 1;
      column <=
      right.length;
      column += 1
    ) {
      const substitutionCost =
        left[
          row - 1
        ] ===
        right[
          column - 1
        ]
          ? 0
          : 1;

      current[column] =
        Math.min(
          (current[
            column - 1
          ] ?? 0) + 1,

          (previous[
            column
          ] ?? 0) + 1,

          (previous[
            column - 1
          ] ?? 0) +
            substitutionCost,
        );
    }

    for (
      let column = 0;
      column <=
      right.length;
      column += 1
    ) {
      previous[column] =
        current[column] ??
        0;
    }
  }

  const distance =
    previous[
      right.length
    ] ?? 0;

  return (
    1 -
    distance /
      Math.max(
        left.length,
        right.length,
      )
  );
}
