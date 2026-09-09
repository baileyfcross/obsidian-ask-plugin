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

const SOURCE_MATCH_THRESHOLD =
  70;

const SOURCE_MATCH_MARGIN =
  4;

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
   * Candidate discovery is performed against the
   * normalized sourceSearchName field added during
   * indexing, so CamelCase filenames are searchable.
   */
  async resolveSourceReference(
    question: string,
  ): Promise<ResolvedSource | null> {
    this.assertReady();

    const terms =
      buildSourceSearchTerms(
        question,
      );

    if (
      terms.length === 0
    ) {
      return null;
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

            limit: 80,

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

    const scored =
      Array.from(
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
        .filter(
          (item) =>
            item.score >=
            SOURCE_MATCH_THRESHOLD,
        )
        .sort(
          (a, b) =>
            b.score -
            a.score,
        );

    const best =
      scored[0];

    if (!best) {
      return null;
    }

    const second =
      scored[1];

    if (
      second &&
      best.score -
        second.score <
        SOURCE_MATCH_MARGIN
    ) {
      /*
       * Do not silently pick between two similarly
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

function toSourceType(
  value: unknown,
): SourceType {
  return value === "pdf"
    ? "pdf"
    : "markdown";
}
