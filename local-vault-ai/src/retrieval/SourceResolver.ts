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
    "document",
    "file",
    "in",
    "my",
    "note",
    "of",
    "on",
    "pdf",
    "source",
    "the",
  ]);

const CONVERSATIONAL_FILLER =
  new Set([
    "about",
    "again",
    "can",
    "could",
    "explain",
    "for",
    "how",
    "it",
    "me",
    "more",
    "please",
    "say",
    "section",
    "summarize",
    "summary",
    "talk",
    "talks",
    "tell",
    "that",
    "this",
    "what",
    "would",
    "you",
  ]);

/**
 * Extract the user's natural-language source/book name.
 *
 * Supported examples include:
 *
 *   What does Foundations of Computing say for section 1.5?
 *
 *   section 1.5 of Foundations of Computation
 *
 *   section 1.5 in my Foundations of Computation book
 *
 *   Can you explain what section 1.5 talks about in my
 *   Foundations of Computation book?
 *
 *   What is section 1.5 about from the Foundations of
 *   Computation PDF?
 *
 *   In my Foundations of Computation book, explain
 *   section 1.5.
 *
 * Follow-ups that do not name a source intentionally
 * return null so RagService can inherit a recent source:
 *
 *   What about section 1.5 again?
 */
export function extractRequestedSourcePhrase(
  question: string,
): string | null {
  const trimmed =
    question.trim();

  /*
   * Strongest signal: the user explicitly says
   * "my/the <title> book/pdf/note/document/file".
   *
   * This handles conversational wording where the
   * source appears well after the numbered section:
   *
   *   section 1.5 talks about in my
   *   Foundations of Computation book
   */
  const namedDocument =
    trimmed.match(
      /\b(?:my|the)\s+(.{4,180}?)\s+(?:book|pdf|note|document|file)\b/i,
    );

  if (
    namedDocument?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        namedDocument[1],
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * Section followed later by a source preposition.
   *
   * The bounded middle portion deliberately permits
   * conversational words:
   *
   *   section 1.5 talks about in my <source>
   *   section 1.5 is about from <source>
   *
   * but does not cross sentence punctuation.
   */
  const sectionThenSource =
    trimmed.match(
      /\b(?:section|sec\.?|§)\s*\d+(?:\.\d+){1,4}\b[^?.!]{0,120}?\b(?:in|from|of)\s+(?:(?:my|the)\s+)?(.+?)(?:\s+(?:book|pdf|note|document|file))?(?:[?.!]|$)/i,
    );

  if (
    sectionThenSource?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        sectionThenSource[1],
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * Simple section-first phrasing:
   *
   *   section 1.5 of Foundations of Computing
   *   section 1.5 in Foundations of Computing
   *
   * Kept separately because it is a very common,
   * high-confidence pattern.
   */
  const sectionFirst =
    trimmed.match(
      /\b(?:section|sec\.?|§)\s*\d+(?:\.\d+){1,4}\s+(?:of|from|in)\s+(.+?)(?:[?.!]|$)/i,
    );

  if (
    sectionFirst?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        sectionFirst[1],
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * Direct "what does <source> say..." phrasing.
   */
  const direct =
    trimmed.match(
      /^\s*(?:can\s+you\s+)?what\s+does\s+(?:(?:my|the)\s+(?:book|pdf|note|file|document)\s+)?(.+?)\s+(?:say|says|talk|talks|cover|covers|mention|mentions)\b/i,
    );

  if (
    direct?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        direct[1],
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * "in/from <source>, section 1.5 ..."
   */
  const inSource =
    trimmed.match(
      /^\s*(?:in|from|according\s+to)\s+(?:(?:my|the)\s+)?(.+?)(?:,\s*|\s+)(?:what\s+(?:does|is)|section|sec\.?|§|explain|summarize)\b/i,
    );

  if (
    inSource?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        inSource[1],
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * Title-before-section wording without a document
   * noun:
   *
   *   Foundations of Computation section 1.5
   *
   * Keep this conservative by requiring the text before
   * "section" to contain at least one meaningful token
   * after conversational framing has been removed.
   */
  const titleBeforeSection =
    trimmed.match(
      /^(.+?)\s+(?:section|sec\.?|§)\s*\d+(?:\.\d+){1,4}\b/i,
    );

  if (
    titleBeforeSection?.[1]
  ) {
    let candidate =
      titleBeforeSection[1]
        .replace(
          /^\s*(?:can\s+you\s+)?(?:please\s+)?(?:explain|summarize|tell\s+me\s+about|what\s+about)\s+/i,
          "",
        )
        .trim();

    const cleaned =
      cleanPhrase(
        candidate,
      );

    if (cleaned) {
      return cleaned;
    }
  }

  /*
   * Generic fallback:
   * remove an explicit section suffix and then strip
   * common question/action framing.
   *
   * This intentionally returns null for:
   *
   *   "What about section 1.5 again?"
   *
   * so conversation source carry-forward can run.
   */
  const sectionMatch =
    trimmed.match(
      /\b(?:section|sec\.?)\s+\d+(?:\.\d+){1,4}\b/i,
    ) ??
    trimmed.match(
      /§\s*\d+(?:\.\d+){1,4}\b/i,
    );

  let working =
    sectionMatch?.index !==
    undefined
      ? trimmed.slice(
          0,
          sectionMatch.index,
        )
      : trimmed;

  working =
    working
      .replace(
        /[?!.]+$/g,
        "",
      )
      .trim();

  working =
    working.replace(
      /^\s*(?:can\s+you\s+)?(?:please\s+)?(?:what\s+does|what\s+do|what\s+is\s+in|according\s+to|from|in|explain|summarize|tell\s+me\s+about)\s+/i,
      "",
    );

  working =
    working.replace(
      /^\s*(?:(?:my|the)\s+)?(?:book|pdf|note|file|document)\s+/i,
      "",
    );

  working =
    working.replace(
      /\s+(?:say|says|talk|talks|cover|covers|mention|mentions)\b.*$/i,
      "",
    );

  return cleanPhrase(
    working,
  );
}

/**
 * Terms used only to discover possible indexed source
 * candidates. Final acceptance uses scoreSourceCandidate.
 *
 * Both original tokens and canonical stems are included,
 * so "computing" can discover "computation" even when the
 * index contains only one of those forms.
 */
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

  const tokens =
    significantTokens(
      normalized,
    );

  const stems =
    tokens
      .map(
        canonicalToken,
      )
      .filter(
        (token) =>
          token.length >= 4,
      );

  const prefixes =
    stems
      .filter(
        (token) =>
          token.length >= 6,
      )
      .map(
        (token) =>
          token.slice(
            0,
            6,
          ),
      );

  return Array.from(
    new Set([
      normalized,
      ...tokens,
      ...stems,
      ...prefixes,
    ]),
  )
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.length -
        left.length,
    )
    .slice(
      0,
      12,
    );
}

/**
 * Fuzzy source-name score.
 *
 * The token score is intentionally strong enough that:
 *
 *   Foundations of Computing
 *   Foundations of Computation
 *
 * are treated as a near-exact title match.
 */
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

  for (
    const name of
    names
  ) {
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
      requested ===
      normalized
    ) {
      best =
        Math.max(
          best,
          100,
        );

      continue;
    }

    const requestedCanonical =
      canonicalPhrase(
        requested,
      );

    const candidateCanonical =
      canonicalPhrase(
        normalized,
      );

    if (
      requestedCanonical &&
      requestedCanonical ===
        candidateCanonical
    ) {
      best =
        Math.max(
          best,
          99,
        );
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

    const blended =
      edit * 0.35 +
      token * 0.50 +
      prefix * 0.15;

    best =
      Math.max(
        best,
        edit * 100,
        token * 96,
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
      .replace(
        /^(?:my|the)\s+/i,
        "",
      )
      .replace(
        /\s+(?:book|pdf|note|file|document)\s*$/i,
        "",
      )
      .trim();

  if (
    cleaned.length < 4
  ) {
    return null;
  }

  const normalized =
    normalizeSourceName(
      cleaned,
    );

  const meaningful =
    normalized
      .split(" ")
      .filter(
        (token) =>
          token.length >= 3 &&
          !STOP_WORDS.has(
            token,
          ) &&
          !CONVERSATIONAL_FILLER.has(
            token,
          ),
      );

  if (
    meaningful.length ===
    0
  ) {
    return null;
  }

  return cleaned;
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

function canonicalPhrase(
  value: string,
): string {
  return significantTokens(
    value,
  )
    .map(
      canonicalToken,
    )
    .join(" ");
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

function canonicalToken(
  token: string,
): string {
  const normalized =
    token
      .toLowerCase()
      .replace(
        /[^a-z0-9]/g,
        "",
      );

  /*
   * computer / computing / computation /
   * computational -> comput
   */
  if (
    /^comput/.test(
      normalized,
    )
  ) {
    return "comput";
  }

  /*
   * Light title-word plural normalization.
   */
  if (
    normalized.length > 5 &&
    normalized.endsWith(
      "s",
    ) &&
    !normalized.endsWith(
      "ss",
    )
  ) {
    return normalized.slice(
      0,
      -1,
    );
  }

  return normalized;
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

function tokensEquivalent(
  left: string,
  right: string,
): boolean {
  const leftCanonical =
    canonicalToken(
      left,
    );

  const rightCanonical =
    canonicalToken(
      right,
    );

  if (
    leftCanonical ===
    rightCanonical
  ) {
    return true;
  }

  if (
    leftCanonical.length >= 6 &&
    rightCanonical.length >= 6
  ) {
    return (
      leftCanonical.slice(
        0,
        6,
      ) ===
      rightCanonical.slice(
        0,
        6,
      )
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
  if (
    left === right
  ) {
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
    row <=
    left.length;
    row += 1
  ) {
    current[0] =
      row;

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
