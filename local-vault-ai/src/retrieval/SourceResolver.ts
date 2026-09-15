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
    "create",
    "explain",
    "for",
    "how",
    "it",
    "lecture",
    "lesson",
    "make",
    "me",
    "more",
    "please",
    "presentation",
    "say",
    "section",
    "slide",
    "slides",
    "summarize",
    "summary",
    "talk",
    "talks",
    "teach",
    "tell",
    "that",
    "this",
    "what",
    "would",
    "you",
  ]);

/**
 * Common instructional/request framing that must NOT be
 * mistaken for a source title.
 *
 * Examples that should produce no explicit source:
 *
 *   Can you create a lecture for section 1.5?
 *   Make slides for section 1.5.
 *   Explain section 1.5.
 *   Give me a lesson for section 1.5.
 *
 * When these return null, RagService is free to inherit
 * the source from recent conversation context.
 */
const REQUEST_FRAMING_PATTERNS:
  RegExp[] = [
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:create|make|write|build|generate|give|prepare|explain|summarize|teach|tell)\b/i,

  /^(?:please\s+)?(?:create|make|write|build|generate|give|prepare|explain|summarize|teach|tell)\b/i,

  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:create|make|write|build|generate|give|prepare)\s+(?:me\s+)?(?:a\s+)?(?:lecture|lesson|presentation|slide(?:s)?|slide\s+deck)\b/i,

  /^(?:create|make|write|build|generate|give|prepare)\s+(?:me\s+)?(?:a\s+)?(?:lecture|lesson|presentation|slide(?:s)?|slide\s+deck)\b/i,

  /^(?:what|how)\s+(?:about|does|do|is|are)\b/i,

  /^(?:tell\s+me|teach\s+me)\b/i,
];

/**
 * Extract the user's natural-language source/book name.
 *
 * Supported examples:
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
 *   Foundations of Computation section 1.5
 *
 * Follow-ups and instruction-only prompts intentionally
 * return null:
 *
 *   What about section 1.5 again?
 *
 *   Can you create a lecture for section 1.5?
 *
 *   Make slides for section 1.5.
 *
 * This allows RagService to inherit a recent source from
 * conversation context rather than treating instruction
 * wording as a title.
 */
export function extractRequestedSourcePhrase(
  question: string,
): string | null {
  const trimmed =
    question.trim();

  /*
   * Strongest signal: explicit document noun.
   *
   * Examples:
   *
   *   my Foundations of Computation book
   *   the Foundations of Computation PDF
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

    if (
      cleaned &&
      !isLikelyRequestFraming(
        cleaned,
      )
    ) {
      return cleaned;
    }
  }

  /*
   * Section followed later by a source preposition.
   *
   * Supports:
   *
   *   section 1.5 talks about in my <source>
   *   section 1.5 is about from <source>
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

    if (
      cleaned &&
      !isLikelyRequestFraming(
        cleaned,
      )
    ) {
      return cleaned;
    }
  }

  /*
   * Simple section-first phrasing:
   *
   *   section 1.5 of Foundations of Computing
   *   section 1.5 in Foundations of Computing
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

    if (
      cleaned &&
      !isLikelyRequestFraming(
        cleaned,
      )
    ) {
      return cleaned;
    }
  }

  /*
   * Direct title-before-action phrasing:
   *
   *   What does Foundations of Computation say...
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

    if (
      cleaned &&
      !isLikelyRequestFraming(
        cleaned,
      )
    ) {
      return cleaned;
    }
  }

  /*
   * Source-first phrasing:
   *
   *   In my Foundations of Computation book, explain...
   *   From Foundations of Computation, summarize...
   */
  const inSource =
    trimmed.match(
      /^\s*(?:in|from|according\s+to)\s+(?:(?:my|the)\s+)?(.+?)(?:,\s*|\s+)(?:what\s+(?:does|is)|section|sec\.?|§|explain|summarize|create|make|teach|tell)\b/i,
    );

  if (
    inSource?.[1]
  ) {
    const cleaned =
      cleanPhrase(
        inSource[1],
      );

    if (
      cleaned &&
      !isLikelyRequestFraming(
        cleaned,
      )
    ) {
      return cleaned;
    }
  }

  /*
   * Title immediately before "section".
   *
   * Valid:
   *
   *   Foundations of Computation section 1.5
   *
   * Invalid:
   *
   *   Can you create a lecture for section 1.5
   *
   *   Make slides for section 1.5
   *
   * This is intentionally conservative because this
   * fallback previously caused instruction text to be
   * treated as a source title.
   */
  const titleBeforeSection =
    trimmed.match(
      /^(.+?)\s+(?:section|sec\.?|§)\s*\d+(?:\.\d+){1,4}\b/i,
    );

  if (
    titleBeforeSection?.[1]
  ) {
    const rawCandidate =
      titleBeforeSection[1]
        .trim();

    if (
      !isLikelyRequestFraming(
        rawCandidate,
      )
    ) {
      const candidate =
        stripRequestFraming(
          rawCandidate,
        );

      const cleaned =
        cleanPhrase(
          candidate,
        );

      if (
        cleaned &&
        !isLikelyRequestFraming(
          cleaned,
        )
      ) {
        return cleaned;
      }
    }
  }

  /*
   * Generic fallback.
   *
   * Take text before the explicit section reference,
   * remove request framing, then only accept it as a
   * source if it still looks like a genuine title.
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

  /*
   * Instruction-only text must resolve to null.
   *
   * Example:
   *
   *   "Can you create a lecture for "
   *
   * is not a source title.
   */
  if (
    isLikelyRequestFraming(
      working,
    )
  ) {
    return null;
  }

  working =
    stripRequestFraming(
      working,
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

  const cleaned =
    cleanPhrase(
      working,
    );

  if (
    !cleaned ||
    isLikelyRequestFraming(
      cleaned,
    )
  ) {
    return null;
  }

  return cleaned;
}

/**
 * Terms used to discover possible indexed sources.
 *
 * Both original tokens and canonical stems are included,
 * so "computing" can discover "computation".
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
 * The token score intentionally treats:
 *
 *   Foundations of Computing
 *   Foundations of Computation
 *
 * as a near-exact title match.
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

function stripRequestFraming(
  value: string,
): string {
  let working =
    value.trim();

  const patterns:
    RegExp[] = [
    /^\s*(?:can|could|would)\s+you\s+(?:please\s+)?/i,

    /^\s*please\s+/i,

    /^\s*(?:create|make|write|build|generate|give|prepare)\s+(?:me\s+)?(?:a\s+)?(?:lecture|lesson|presentation|slide(?:s)?|slide\s+deck)\s+(?:about|on|for|from)?\s*/i,

    /^\s*(?:explain|summarize|teach|tell\s+me\s+about)\s+/i,

    /^\s*(?:what\s+does|what\s+do|what\s+is\s+in|according\s+to|from|in)\s+/i,
  ];

  let changed =
    true;

  while (changed) {
    changed =
      false;

    for (
      const pattern of
      patterns
    ) {
      const next =
        working.replace(
          pattern,
          "",
        );

      if (
        next !== working
      ) {
        working =
          next.trim();

        changed =
          true;
      }
    }
  }

  return working;
}

function isLikelyRequestFraming(
  value: string,
): boolean {
  const trimmed =
    value
      .trim()
      .replace(
        /[,:;.!?]+$/g,
        "",
      );

  if (!trimmed) {
    return true;
  }

  for (
    const pattern of
    REQUEST_FRAMING_PATTERNS
  ) {
    if (
      pattern.test(
        trimmed,
      )
    ) {
      return true;
    }
  }

  const normalized =
    normalizeSourceName(
      trimmed,
    );

  const tokens =
    normalized
      .split(" ")
      .filter(Boolean);

  if (
    tokens.length === 0
  ) {
    return true;
  }

  const meaningful =
    tokens.filter(
      (token) =>
        token.length >= 3 &&
        !STOP_WORDS.has(
          token,
        ) &&
        !CONVERSATIONAL_FILLER.has(
          token,
        ),
    );

  /*
   * A phrase composed entirely of request vocabulary
   * is not a source.
   *
   * Examples:
   *
   *   create a lecture for
   *   make slides for
   *   explain this
   */
  if (
    meaningful.length ===
    0
  ) {
    return true;
  }

  /*
   * If the phrase begins with a request verb and all
   * remaining meaningful words are generic teaching
   * output nouns, treat it as framing rather than a
   * title.
   */
  const first =
    tokens[0] ??
    "";

  const requestVerb =
    new Set([
      "build",
      "create",
      "explain",
      "generate",
      "give",
      "make",
      "prepare",
      "summarize",
      "teach",
      "tell",
      "write",
    ]);

  if (
    requestVerb.has(
      first,
    )
  ) {
    return true;
  }

  return false;
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

  if (
    isLikelyRequestFraming(
      cleaned,
    )
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
