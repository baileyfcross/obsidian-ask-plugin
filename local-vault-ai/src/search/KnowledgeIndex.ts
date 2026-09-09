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

interface SourceCandidate {
  filePath: string;
  fileName: string;
  title: string;
  sourceType: SourceType;
}

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
         * sourceKey/sourceType are enums because
         * Orama can efficiently apply exact filters
         * to enum properties.
         */
        sourceKey: "enum",
        sourceType: "enum",

        filePath: "string",
        fileName: "string",
        folder: "string",
        title: "string",
        heading: "string",
        content: "string",

        tags: "string[]",
        links: "string[]",
        properties:
          "string[]",

        pageStart:
          "number",
        pageEnd:
          "number",

        mtime: "number",

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
      Record<string, unknown> = {
        mode: "hybrid",
        term: query,

        properties: [
          "filePath",
          "fileName",
          "title",
          "heading",
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
        sourceKey:
          options.sourcePath,
      };
    }

    const results =
      await search(
        this.db,
        request as any,
      );

    return (
      results.hits ?? []
    ).map(
      (
        hit: any,
      ): RetrievedChunk => {
        const document =
          hit.document;

        return {
          id:
            document.id,

          sourceType:
            toSourceType(
              document
                .sourceType,
            ),

          filePath:
            document.filePath,

          fileName:
            document.fileName,

          title:
            document.title,

          heading:
            document.heading,

          content:
            document.content,

          tags:
            document.tags ??
            [],

          links:
            document.links ??
            [],

          pageStart:
            document.pageStart ??
            0,

          pageEnd:
            document.pageEnd ??
            0,

          score:
            hit.score,
        };
      },
    );
  }


  /**
   * Fast lexical lookup for an explicitly requested
   * section inside one already-resolved source.
   *
   * This intentionally avoids generating an embedding.
   * For questions such as "section 1.5", the printed
   * section number is a stronger signal than semantic
   * similarity and is much cheaper to retrieve.
   */
  async searchSectionInSource(
    sourcePath: string,
    sectionIdentifier: string,
    limit = 6,
  ): Promise<RetrievedChunk[]> {
    this.assertReady();

    const searchTerms = [
      sectionIdentifier,
      `section ${sectionIdentifier}`,
    ];

    const candidates =
      new Map<
        string,
        {
          chunk:
            RetrievedChunk;
          rawScore: number;
        }
      >();

    for (
      const term of
      searchTerms
    ) {
      const results =
        await search(
          this.db,
          {
            term,

            properties: [
              "heading",
              "content",
            ],

            where: {
              sourceKey:
                sourcePath,
            },

            /*
             * Pull a wider lexical candidate set,
             * then rank exact section headings
             * ourselves.
             */
            limit:
              Math.max(
                40,
                limit * 6,
              ),

            includeVectors:
              false,
          } as any,
        );

      for (
        const hit of
        results.hits ?? []
      ) {
        const document =
          (hit as any)
            .document;

        const id =
          String(
            document.id,
          );

        const chunk:
          RetrievedChunk = {
            id,

            sourceType:
              toSourceType(
                document
                  .sourceType,
              ),

            filePath:
              String(
                document
                  .filePath,
              ),

            fileName:
              String(
                document
                  .fileName,
              ),

            title:
              String(
                document
                  .title,
              ),

            heading:
              String(
                document
                  .heading ??
                  "",
              ),

            content:
              String(
                document
                  .content ??
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
                document
                  .pageStart ??
                  0,
              ),

            pageEnd:
              Number(
                document
                  .pageEnd ??
                  0,
              ),

            score:
              Number(
                (hit as any)
                  .score ??
                  0,
              ),
          };

        const existing =
          candidates.get(id);

        const rawScore =
          Math.max(
            existing?.rawScore ??
              0,
            chunk.score,
          );

        candidates.set(
          id,
          {
            chunk,
            rawScore,
          },
        );
      }
    }

    const escaped =
      escapeRegExp(
        sectionIdentifier,
      );

    const headingPattern =
      new RegExp(
        `^\\s*(?:section\\s+)?${escaped}(?:\\D|$)`,
        "i",
      );

    const inlinePattern =
      new RegExp(
        `(?:^|\\n)\\s*(?:section\\s+)?${escaped}(?:\\D|$)`,
        "i",
      );

    const ranked =
      Array.from(
        candidates.values(),
      )
        .map(
          ({
            chunk,
            rawScore,
          }) => {
            let sectionBoost =
              0;

            if (
              headingPattern.test(
                chunk.heading,
              )
            ) {
              sectionBoost +=
                1000;
            }

            if (
              inlinePattern.test(
                chunk.content,
              )
            ) {
              sectionBoost +=
                350;
            }

            /*
             * PdfChunker keeps the current section
             * heading on later chunks from the same
             * section, so all chunks belonging to
             * section 1.5 naturally stay together.
             */
            return {
              chunk,
              score:
                sectionBoost +
                rawScore,
            };
          },
        )
        .filter(
          (item) =>
            item.score >
            0,
        )
        .sort(
          (a, b) =>
            b.score -
            a.score,
        );

    return ranked
      .slice(
        0,
        limit,
      )
      .map(
        (item) => ({
          ...item.chunk,

          /*
           * Keep the original Orama score visible
           * to citations / diagnostics.
           */
          score:
            item.chunk
              .score,
        }),
      );
  }

  /**
   * Detect an explicitly named note/book/file in the
   * user's question before normal RAG retrieval.
   *
   * This is deliberately conservative: it only
   * returns a match when the filename/title evidence
   * is strong enough to justify restricting search
   * to a single source.
   */
  async resolveSourceReference(
    question: string,
  ): Promise<ResolvedSource | null> {
    this.assertReady();

    const normalizedQuestion =
      normalizeSourceText(
        question,
      );

    if (
      normalizedQuestion.length <
      4
    ) {
      return null;
    }

    const result =
      await search(
        this.db,
        {
          term: question,
          properties: [
            "fileName",
            "title",
            "filePath",
          ],
          limit: 80,
          includeVectors:
            false,
        } as any,
      );

    const candidates =
      new Map<
        string,
        SourceCandidate
      >();

    for (
      const hit of
      result.hits ?? []
    ) {
      const document =
        (hit as any)
          .document;

      const filePath =
        document.filePath;

      if (
        typeof filePath !==
          "string" ||
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

    let best:
      | ResolvedSource
      | null = null;

    for (
      const candidate of
      candidates.values()
    ) {
      const confidence =
        scoreCandidate(
          normalizedQuestion,
          candidate,
        );

      if (
        !best ||
        confidence >
          best.confidence
      ) {
        best = {
          ...candidate,
          confidence,
        };
      }
    }

    /*
     * 86 is high enough to require a strong
     * filename/title match, while still allowing:
     *
     * requested:
     * FoundationsOfComputation_2.3.2
     *
     * indexed:
     * FoundationsOfComputation_2.3.2_8.5x11.pdf
     */
    if (
      !best ||
      best.confidence < 86
    ) {
      return null;
    }

    return best;
  }

  private assertReady(): void {
    if (!this.db) {
      throw new Error(
        "The knowledge index is not loaded. Rebuild the index first.",
      );
    }
  }
}

function scoreCandidate(
  normalizedQuestion: string,
  candidate:
    SourceCandidate,
): number {
  const names = [
    candidate.fileName,
    candidate.title,
    candidate.filePath
      .split("/")
      .pop() ??
      candidate.filePath,
  ];

  let best = 0;

  for (const name of names) {
    const normalizedName =
      normalizeSourceText(
        stripKnownExtension(
          name,
        ),
      );

    if (
      normalizedName.length <
      4
    ) {
      continue;
    }

    if (
      normalizedQuestion.includes(
        normalizedName,
      )
    ) {
      best =
        Math.max(
          best,
          120,
        );

      continue;
    }

    const tokens =
      normalizedName
        .split(" ")
        .filter(Boolean);

    /*
     * Walk backwards through filename prefixes.
     * This handles extra suffixes such as:
     *   _8.5x11
     *   _final
     *   _scan
     */
    for (
      let end =
        tokens.length - 1;
      end >= 1;
      end -= 1
    ) {
      const prefix =
        tokens
          .slice(0, end)
          .join(" ");

      if (
        prefix.length <
        8
      ) {
        continue;
      }

      if (
        normalizedQuestion
          .includes(prefix)
      ) {
        const coverage =
          end /
          tokens.length;

        best =
          Math.max(
            best,
            92 +
              coverage *
                18,
          );

        break;
      }
    }

    const queryTokens =
      new Set(
        normalizedQuestion
          .split(" ")
          .filter(
            (token) =>
              token.length >=
              2,
          ),
      );

    const sourceTokens =
      tokens.filter(
        (token) =>
          token.length >= 2,
      );

    if (
      sourceTokens.length >
      0
    ) {
      const matches =
        sourceTokens.filter(
          (token) =>
            queryTokens.has(
              token,
            ),
        ).length;

      const overlap =
        matches /
        sourceTokens.length;

      best =
        Math.max(
          best,
          overlap * 82,
        );
    }
  }

  return best;
}

function normalizeSourceText(
  value: string,
): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(
      /[_\\/\-]+/g,
      " ",
    )
    .replace(
      /[^\p{L}\p{N}.]+/gu,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function stripKnownExtension(
  value: string,
): string {
  return value.replace(
    /\.(?:md|pdf)$/i,
    "",
  );
}


function escapeRegExp(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function toSourceType(
  value: unknown,
): SourceType {
  return value === "pdf"
    ? "pdf"
    : "markdown";
}
