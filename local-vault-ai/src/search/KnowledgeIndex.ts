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
  VaultChunk,
} from "../types";

export interface HybridSearchOptions {
  limit: number;
  textWeight: number;
  vectorWeight: number;
  similarity: number;
}

export class KnowledgeIndex {
  private db: any | null = null;
  private dimensions = 0;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly indexPath: string,
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
    this.dimensions = dimensions;

    this.db = create({
      id: "local-vault-ai",
      schema: {
        id: "string",
        filePath: "string",
        fileName: "string",
        folder: "string",
        title: "string",
        heading: "string",
        content: "string",
        tags: "string[]",
        links: "string[]",
        properties: "string[]",
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
      !(await this.adapter.exists(
        this.indexPath,
      ))
    ) {
      throw new Error(
        "The persisted knowledge index does not exist.",
      );
    }

    const serialized =
      await this.adapter.read(
        this.indexPath,
      );

    const raw =
      JSON.parse(serialized);

    await this.createEmpty(dimensions);

    await loadOrama(
      this.db,
      raw,
    );
  }

  async save(): Promise<void> {
    this.assertReady();

    const raw =
      await saveOrama(this.db);

    await this.adapter.write(
      this.indexPath,
      JSON.stringify(raw),
    );
  }

  async existsOnDisk(): Promise<boolean> {
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
      // A stale manifest should not block re-indexing.
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
    options: HybridSearchOptions,
  ): Promise<RetrievedChunk[]> {
    this.assertReady();

    const results =
      await search(
        this.db,
        {
          mode: "hybrid",
          term: query,
          properties: [
            "title",
            "heading",
            "content",
            "tags",
            "links",
            "properties",
          ],
          vector: {
            value: queryEmbedding,
            property: "embedding",
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
          includeVectors: false,
        } as any,
      );

    return (results.hits ?? []).map(
      (hit: any): RetrievedChunk => {
        const document =
          hit.document;

        return {
          id: document.id,
          filePath:
            document.filePath,
          title:
            document.title,
          heading:
            document.heading,
          content:
            document.content,
          tags:
            document.tags ?? [],
          links:
            document.links ?? [],
          score:
            hit.score,
        };
      },
    );
  }

  private assertReady(): void {
    if (!this.db) {
      throw new Error(
        "The knowledge index is not loaded. Rebuild the index first.",
      );
    }
  }
}
