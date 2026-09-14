import {
  create,
  insert,
  load as loadOrama,
  remove,
  save as saveOrama,
  search,
} from "@orama/orama";
import {
  DataAdapter,
} from "obsidian";
import {
  RetrievedChunk,
  SourceType,
  VaultChunk,
} from "../types";
import {
  buildSourceSearchTerms,
  normalizeSourceName,
  scoreSourceCandidate,
  SourceCandidateDescriptor,
} from "../retrieval/SourceResolver";

export interface HybridSearchOptions {
  limit: number;
  textWeight: number;
  vectorWeight: number;
  similarity: number;

  /*
   * When set, hybrid retrieval is restricted to
   * exactly one indexed source.
   */
  sourcePath?: string;
}

export interface ResolvedSource {
  filePath: string;
  fileName: string;
  title: string;
  sourceType: SourceType;
  confidence: number;
}

export interface DetectedSection {
  number: string;
  title: string;
}

const SOURCE_MATCH_THRESHOLD =
  68;

const SOURCE_MATCH_MARGIN =
  5;

const SOURCE_SUGGESTION_THRESHOLD =
  35;

export class KnowledgeIndex {
  private db:
    any | null = null;

  private dimensions = 0;

  constructor(
    private readonly adapter:
      DataAdapter,
    private readonly indexPath:
      string,
  ) {}

  isReady(): boolean {
    return this.db !== null;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  async createEmpty(
    dimensions: number,
  ): Promise<void> {
    this.dimensions =
      dimensions;

    this.db = create({
      id:
        "local-vault-ai",

      schema: {
        id: "string",

        /*
         * Enum fields support exact filters.
         */
        sourceKey:
          "enum",

        sourceType:
          "enum",

        sectionKey:
          "enum",

        /*
         * Normalized source-name text used only for
         * source resolution.
         */
        sourceSearchName:
          "string",

        filePath:
          "string",

        fileName:
          "string",

        folder:
          "string",

        title:
          "string",

        heading:
          "string",

        sectionNumber:
          "string",

        sectionTitle:
          "string",

        content:
          "string",

        tags:
          "string[]",

        links:
          "string[]",

        properties:
          "string[]",

        pageStart:
          "number",

        pageEnd:
          "number",

        mtime:
          "number",

        embedding:
          `vector[${dimensions}]`,
      },
    } as any);
  }

  async load(
    dimensions: number,
  ): Promise<void> {
    if (
      !(await this.adapter
        .exists(
          this.indexPath,
        ))
    ) {
      throw new Error(
        "The persisted knowledge index does not exist.",
      );
    }

    const serialized =
      await this.adapter
        .read(
          this.indexPath,
        );

    const raw =
      JSON.parse(
        serialized,
      );

    await this.createEmpty(
      dimensions,
    );

    await loadOrama(
      this.db,
      raw,
    );
  }

  async save(): Promise<void> {
    this.assertReady();

    const raw =
      await saveOrama(
        this.db,
      );

    await this.adapter.write(
      this.indexPath,
      JSON.stringify(raw),
    );
  }

  async existsOnDisk():
    Promise<boolean> {
    return this.adapter.exists(
      this.indexPath,
    );
  }

  async add(
    chunk: VaultChunk,
  ): Promise<void> {
    this.assertReady();

    await insert(
      this.db,
      chunk as any,
    );
  }

  async remove(
    id: string,
  ): Promise<void> {
    this.assertReady();

    try {
      await remove(
        this.db,
        id,
      );
    } catch {
      /*
       * A stale manifest should not
       * block re-indexing.
       */
    }
  }

  async removeMany(
    ids: string[],
  ): Promise<void> {
    for (const id of ids) {
      await this.remove(id);
    }
  }

  async hybridSearch(
    query: string,
    queryEmbedding: number[],
    options:
      HybridSearchOptions,
  ): Promise<RetrievedChunk[]> {
    this.assertReady();

    const request:
      Record<
        string,
        unknown
      > = {
        mode: "hybrid",

        term:
          query,

        properties: [
          "sourceSearchName",
          "filePath",
          "fileName",
          "title",
          "heading",
          "sectionNumber",
          "sectionTitle",
          "content",
          "tags",
          "links",
          "properties",
        ],

        vector: {
          value:
            queryEmbedding,

          property:
            "embedding",
        },

        hybridWeights: {
          text:
            options.textWeight,

          vector:
            options.vectorWeight,
        },

        similarity:
          options.similarity,

        limit:
          options.limit,

        includeVectors:
          false,
      };

    if (
      options.sourcePath
    ) {
      request.where = {
        sourceKey: {
          eq:
            options.sourcePath,
        },
      };
    }

    const results =
      await search(
        this.db,
        request as any,
      );

    return (
      results.hits ??
      []
    ).map(
      (
        hit: any,
      ) =>
        this.toRetrievedChunk(
          hit.document,
          Number(
            hit.score ??
            0,
          ),
        ),
    );
  }

  /**
   * Exact metadata lookup for a numbered section.
   *
   * This does NOT search arbitrary occurrences of
   * "1.5" in figures, tables, equations, indexes,
   * or the table of contents.
   */
  async searchExactSection(
    sourcePath: string,
    sectionNumber: string,
    limit = 12,
  ): Promise<RetrievedChunk[]> {
    this.assertReady();

    const normalizedSection =
      normalizeSectionNumber(
        sectionNumber,
      );

    const results =
      await search(
        this.db,
        {
          term:
            normalizedSection,

          properties: [
            "sectionNumber",
            "sectionTitle",
            "heading",
            "content",
          ],

          where: {
            sourceKey: {
              eq:
                sourcePath,
            },

            sectionKey: {
              eq:
                normalizedSection,
            },
          },

          /*
           * Pull more than the final RAG budget, then
           * restore document order by page/chunk id.
           */
          limit:
            Math.max(
              limit,
              24,
            ),

          includeVectors:
            false,
        } as any,
      );

    return (
      results.hits ??
      []
    )
      .map(
        (
          hit: any,
        ) =>
          this.toRetrievedChunk(
            hit.document,
            Number(
              hit.score ??
              0,
            ),
          ),
      )
      .filter(
        (
          chunk:
            RetrievedChunk,
        ) =>
          chunk
            .sectionNumber ===
          normalizedSection,
      )
      .sort(
        compareDocumentOrder,
      )
      .slice(
        0,
        limit,
      );
  }

  /**
   * Resolve the source named in a natural-language
   * question.
   *
   * Candidate discovery is intentionally broad.
   * Final acceptance is controlled by the dedicated
   * fuzzy source-name scorer.
   */
  async resolveSourceReference(
    question: string,
  ): Promise<ResolvedSource | null> {
    this.assertReady();

    const scored =
      await this
        .scoreSourceCandidates(
          question,
        );

    const accepted =
      scored.filter(
        (item) =>
          item.score >=
          SOURCE_MATCH_THRESHOLD,
      );

    const best =
      accepted[0];

    if (!best) {
      return null;
    }

    const second =
      accepted[1];

    if (
      second &&
      best.score -
        second.score <
        SOURCE_MATCH_MARGIN
    ) {
      /*
       * Do not silently choose between similarly
       * named books/notes.
       */
      return null;
    }

    return {
      ...best.candidate,

      confidence:
        Math.round(
          best.score,
        ),
    };
  }

  /**
   * Lower-confidence source suggestions are useful when
   * an explicit section request must fail closed.
   */
  async findSourceSuggestions(
    question: string,
    limit = 3,
  ): Promise<ResolvedSource[]> {
    this.assertReady();

    const scored =
      await this
        .scoreSourceCandidates(
          question,
        );

    return scored
      .filter(
        (item) =>
          item.score >=
          SOURCE_SUGGESTION_THRESHOLD,
      )
      .slice(
        0,
        Math.max(
          1,
          limit,
        ),
      )
      .map(
        (item) => ({
          ...item.candidate,

          confidence:
            Math.round(
              item.score,
            ),
        }),
      );
  }

  /**
   * Diagnostic helper used only when an exact numbered
   * section was requested but no matching chunks exist.
   *
   * This tells us whether the PDF parser/indexer actually
   * recorded section metadata such as 1.4, 1.5, 1.6.
   */
  async listSectionsInSource(
    sourcePath: string,
    limit = 100,
  ): Promise<DetectedSection[]> {
    this.assertReady();

    const fileName =
      sourcePath
        .split("/")
        .pop() ??
      sourcePath;

    const term =
      normalizeSourceName(
        fileName,
      ) ||
      fileName;

    const results =
      await search(
        this.db,
        {
          term,

          properties: [
            "sourceSearchName",
            "fileName",
            "filePath",
            "title",
          ],

          where: {
            sourceKey: {
              eq:
                sourcePath,
            },
          },

          limit:
            5000,

          includeVectors:
            false,
        } as any,
      );

    const sections =
      new Map<
        string,
        string
      >();

    for (
      const hit of
      results.hits ??
      []
    ) {
      const document =
        (hit as any)
          .document;

      const number =
        normalizeSectionNumber(
          String(
            document
              .sectionNumber ??
            "",
          ),
        );

      if (!number) {
        continue;
      }

      if (
        !sections.has(
          number,
        )
      ) {
        sections.set(
          number,
          String(
            document
              .sectionTitle ??
            "",
          ),
        );
      }
    }

    return Array.from(
      sections.entries(),
    )
      .map(
        (
          [
            number,
            title,
          ],
        ) => ({
          number,
          title,
        }),
      )
      .sort(
        (
          left,
          right,
        ) =>
          compareSectionNumbers(
            left.number,
            right.number,
          ),
      )
      .slice(
        0,
        Math.max(
          1,
          limit,
        ),
      );
  }

  private async scoreSourceCandidates(
    question: string,
  ): Promise<
    Array<{
      candidate:
        SourceCandidateDescriptor;

      score:
        number;
    }>
  > {
    const terms =
      buildSourceSearchTerms(
        question,
      );

    if (
      terms.length === 0
    ) {
      return [];
    }

    const candidates =
      new Map<
        string,
        SourceCandidateDescriptor
      >();

    for (
      const term of
      terms
    ) {
      if (
        !term ||
        term.length < 4
      ) {
        continue;
      }

      const result =
        await search(
          this.db,
          {
            term,

            properties: [
              "sourceSearchName",
              "title",
              "fileName",
              "filePath",
            ],

            /*
             * A small tolerance helps ordinary typos.
             * Morphological differences are handled by
             * source terms/scoring rather than by relying
             * on edit distance inside Orama.
             */
            tolerance:
              term.length >= 7
                ? 1
                : 0,

            limit:
              120,

            includeVectors:
              false,
          } as any,
        );

      for (
        const hit of
        result.hits ??
        []
      ) {
        const document =
          (hit as any)
            .document;

        const filePath =
          String(
            document.filePath ??
            "",
          );

        if (
          !filePath ||
          candidates.has(
            filePath,
          )
        ) {
          continue;
        }

        candidates.set(
          filePath,
          {
            filePath,

            fileName:
              String(
                document.fileName ??
                filePath,
              ),

            title:
              String(
                document.title ??
                document.fileName ??
                filePath,
              ),

            sourceType:
              toSourceType(
                document
                  .sourceType,
              ),
          },
        );
      }
    }

    return Array.from(
      candidates.values(),
    )
      .map(
        (candidate) => ({
          candidate,

          score:
            scoreSourceCandidate(
              question,
              candidate,
            ),
        }),
      )
      .sort(
        (left, right) =>
          right.score -
          left.score,
      );
  }

  private toRetrievedChunk(
    document: any,
    score: number,
  ): RetrievedChunk {
    return {
      id:
        String(
          document.id,
        ),

      sourceType:
        toSourceType(
          document
            .sourceType,
        ),

      filePath:
        String(
          document.filePath ??
          "",
        ),

      fileName:
        String(
          document.fileName ??
          "",
        ),

      title:
        String(
          document.title ??
          "",
        ),

      heading:
        String(
          document.heading ??
          "",
        ),

      sectionNumber:
        String(
          document
            .sectionNumber ??
          "",
        ),

      sectionTitle:
        String(
          document
            .sectionTitle ??
          "",
        ),

      content:
        String(
          document.content ??
          "",
        ),

      tags:
        document.tags ??
        [],

      links:
        document.links ??
        [],

      pageStart:
        Number(
          document.pageStart ??
          0,
        ),

      pageEnd:
        Number(
          document.pageEnd ??
          0,
        ),

      score,
    };
  }

  private assertReady(): void {
    if (!this.db) {
      throw new Error(
        "The knowledge index is not loaded. Rebuild the index first.",
      );
    }
  }
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

function compareDocumentOrder(
  left:
    RetrievedChunk,
  right:
    RetrievedChunk,
): number {
  if (
    left.pageStart !==
    right.pageStart
  ) {
    return (
      left.pageStart -
      right.pageStart
    );
  }

  const leftIndex =
    chunkIndexFromId(
      left.id,
    );

  const rightIndex =
    chunkIndexFromId(
      right.id,
    );

  return (
    leftIndex -
    rightIndex
  );
}

function chunkIndexFromId(
  id: string,
): number {
  const match =
    id.match(
      /::(\d+)$/,
    );

  return match?.[1]
    ? Number(
        match[1],
      )
    : 0;
}

function compareSectionNumbers(
  left: string,
  right: string,
): number {
  const leftParts =
    left
      .split(".")
      .map(Number);

  const rightParts =
    right
      .split(".")
      .map(Number);

  const length =
    Math.max(
      leftParts.length,
      rightParts.length,
    );

  for (
    let index = 0;
    index < length;
    index += 1
  ) {
    const leftValue =
      leftParts[index] ??
      0;

    const rightValue =
      rightParts[index] ??
      0;

    if (
      leftValue !==
      rightValue
    ) {
      return (
        leftValue -
        rightValue
      );
    }
  }

  return left.localeCompare(
    right,
  );
}

function toSourceType(
  value: unknown,
): SourceType {
  return value === "pdf"
    ? "pdf"
    : "markdown";
}
