import {
  create,
  getByID,
  insert,
  insertMultiple,
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
import {
  sha256,
} from "../indexing/Hash";

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


/*
 * V8 cannot create JSON strings larger than roughly 512 MiB. Large
 * vaults with many embedded PDF chunks can exceed that limit even
 * though Orama itself can still hold the index in memory.
 *
 * Persist the Orama RawData as many small JSON shards instead of one
 * monolithic JSON.stringify(raw) call. The small knowledge-index.json
 * file becomes a manifest that points at those shards.
 */
const LEGACY_SHARDED_INDEX_FORMAT =
  "local-vault-ai-orama-sharded-v1";

const LEGACY_SHARDED_INDEX_VERSION =
  1;

const SHARDED_INDEX_FORMAT =
  "local-vault-ai-orama-sharded-v2";

const SHARDED_INDEX_VERSION =
  2;

const SHARD_TARGET_CHARACTERS =
  8 * 1024 * 1024;

const SHARD_INITIAL_GROUP_SIZE =
  256;

const SHARD_IO_YIELD_INTERVAL =
  4;

interface ShardFileRange {
  start: number;
  file: string;
}

interface ShardArrayChild {
  index: number;
  node: ShardNode;
}

interface ShardObjectChild {
  key: string;
  node: ShardNode;
}

type ShardNode =
  | {
      kind: "inline";
      value: unknown;
    }
  | {
      kind: "undefined";
    }
  | {
      kind: "file";
      file: string;
    }
  | {
      kind: "array";
      length: number;
      files: ShardFileRange[];
      children: ShardArrayChild[];
    }
  | {
      kind: "object";
      files: string[];
      children: ShardObjectChild[];
    };

interface ShardedIndexManifest {
  format: typeof SHARDED_INDEX_FORMAT;
  version: typeof SHARDED_INDEX_VERSION;
  dimensions: number;
  createdAt: number;
  generation: string;
  shardFiles: string[];
  root: ShardNode;
}

interface ShardWriteContext {
  generation: string;
  shardDirectory: string;
  shardFiles: string[];
  nextPart: number;
  writesSinceYield: number;
}

interface ShardReadContext {
  readsSinceYield: number;
}

export class KnowledgeIndex {
  private db:
    any | null = null;

  private dimensions = 0;

  private dirty = false;

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

    this.dirty = true;
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

    const parsed =
      JSON.parse(
        serialized,
      );

    if (
      isShardedIndexManifest(
        parsed,
      )
    ) {
      const raw =
        await this.readShardedNode(
          parsed.root,
          {
            readsSinceYield: 0,
          },
        );

      await this.createEmpty(
        dimensions,
      );

      await loadOrama(
        this.db,
        raw as Parameters<typeof loadOrama>[1],
      );

      this.dirty = false;

      return;
    }

    /*
     * Backward compatibility with the original single-file JSON
     * snapshot format. Existing smaller indexes continue to load.
     */
    await this.createEmpty(
      dimensions,
    );

    await loadOrama(
      this.db,
      parsed,
    );

    this.dirty = false;
  }

  async save(): Promise<void> {
    this.assertReady();

    if (
      !this.dirty &&
      await this.adapter.exists(
        this.indexPath,
      )
    ) {
      return;
    }

    const raw =
      await saveOrama(
        this.db,
      );

    const shardDirectory =
      this.getShardDirectory();

    await this.ensureDirectory(
      shardDirectory,
    );

    const generation =
      createShardGeneration();

    const context:
      ShardWriteContext = {
        generation,
        shardDirectory,
        shardFiles: [],
        nextPart: 0,
        writesSinceYield: 0,
      };

    const root =
      await this.writeShardedNode(
        raw,
        context,
      );

    const snapshotIdentity =
      await sha256(
        JSON.stringify({
          dimensions:
            this.dimensions,
          root,
        }),
      );

    const manifest:
      ShardedIndexManifest = {
        format:
          SHARDED_INDEX_FORMAT,
        version:
          SHARDED_INDEX_VERSION,
        dimensions:
          this.dimensions,
        createdAt:
          Date.now(),
        generation:
          snapshotIdentity,
        shardFiles:
          context.shardFiles,
        root,
      };

    let existingGeneration:
      string | null = null;

    try {
      if (
        await this.adapter.exists(
          this.indexPath,
        )
      ) {
        const existingSerialized =
          await this.adapter.read(
            this.indexPath,
          );

        const existingParsed =
          JSON.parse(
            existingSerialized,
          );

        if (
          isShardedIndexManifest(
            existingParsed,
          )
        ) {
          existingGeneration =
            existingParsed.generation;
        }
      }
    } catch {
      /*
       * A stale/corrupt runtime manifest should not prevent writing the
       * freshly serialized snapshot.
       */
    }

    /*
     * Content-addressed shards keep their filenames forever. If the
     * Orama snapshot is byte-for-byte identical, do not rewrite the small
     * manifest either. Git therefore sees no index change at all.
     */
    if (
      existingGeneration !==
      snapshotIdentity
    ) {
      await this.adapter.write(
        this.indexPath,
        JSON.stringify(
          manifest,
        ),
      );
    }

    await this.cleanupOldShards(
      new Set(
        context.shardFiles,
      ),
    );

    this.dirty = false;
  }

  private async writeShardedNode(
    value: unknown,
    context: ShardWriteContext,
  ): Promise<ShardNode> {
    if (
      value === undefined
    ) {
      return {
        kind: "undefined",
      };
    }

    if (
      value === null ||
      typeof value !==
        "object"
    ) {
      const serialized =
        serializeForShard(
          value,
        );

      if (
        serialized.length <=
        SHARD_TARGET_CHARACTERS
      ) {
        return {
          kind: "inline",
          value,
        };
      }

      return {
        kind: "file",
        file:
          await this.writeShard(
            serialized,
            context,
          ),
      };
    }

    if (
      Array.isArray(value)
    ) {
      return this.writeShardedArray(
        value,
        context,
      );
    }

    return this.writeShardedObject(
      value as Record<
        string,
        unknown
      >,
      context,
    );
  }

  private async writeShardedArray(
    values: unknown[],
    context: ShardWriteContext,
  ): Promise<ShardNode> {
    if (
      values.length === 0
    ) {
      return {
        kind: "inline",
        value: [],
      };
    }

    const files:
      ShardFileRange[] = [];

    const children:
      ShardArrayChild[] = [];

    for (
      let start = 0;
      start < values.length;
      start +=
        SHARD_INITIAL_GROUP_SIZE
    ) {
      await this.writeArrayRange(
        values,
        start,
        Math.min(
          values.length,
          start +
            SHARD_INITIAL_GROUP_SIZE,
        ),
        files,
        children,
        context,
      );
    }

    return {
      kind: "array",
      length:
        values.length,
      files,
      children,
    };
  }

  private async writeArrayRange(
    values: unknown[],
    start: number,
    end: number,
    files: ShardFileRange[],
    children: ShardArrayChild[],
    context: ShardWriteContext,
  ): Promise<void> {
    const slice =
      values.slice(
        start,
        end,
      );

    const serialized =
      trySerializeForShard(
        slice,
      );

    if (
      serialized !== null &&
      serialized.length <=
        SHARD_TARGET_CHARACTERS
    ) {
      files.push({
        start,
        file:
          await this.writeShard(
            serialized,
            context,
          ),
      });

      return;
    }

    if (
      end - start > 1
    ) {
      const middle =
        start +
        Math.floor(
          (end - start) /
            2,
        );

      await this.writeArrayRange(
        values,
        start,
        middle,
        files,
        children,
        context,
      );

      await this.writeArrayRange(
        values,
        middle,
        end,
        files,
        children,
        context,
      );

      return;
    }

    children.push({
      index: start,
      node:
        await this.writeShardedNode(
          values[start],
          context,
        ),
    });
  }

  private async writeShardedObject(
    value: Record<
      string,
      unknown
    >,
    context: ShardWriteContext,
  ): Promise<ShardNode> {
    const keys =
      Object.keys(
        value,
      );

    if (
      keys.length === 0
    ) {
      return {
        kind: "inline",
        value: {},
      };
    }

    const files:
      string[] = [];

    const children:
      ShardObjectChild[] = [];

    for (
      let start = 0;
      start < keys.length;
      start +=
        SHARD_INITIAL_GROUP_SIZE
    ) {
      await this.writeObjectRange(
        value,
        keys,
        start,
        Math.min(
          keys.length,
          start +
            SHARD_INITIAL_GROUP_SIZE,
        ),
        files,
        children,
        context,
      );
    }

    return {
      kind: "object",
      files,
      children,
    };
  }

  private async writeObjectRange(
    value: Record<
      string,
      unknown
    >,
    keys: string[],
    start: number,
    end: number,
    files: string[],
    children: ShardObjectChild[],
    context: ShardWriteContext,
  ): Promise<void> {
    const piece:
      Record<
        string,
        unknown
      > = {};

    for (
      let index = start;
      index < end;
      index += 1
    ) {
      const key =
        keys[index];

      if (
        key !== undefined
      ) {
        piece[key] =
          value[key];
      }
    }

    const serialized =
      trySerializeForShard(
        piece,
      );

    if (
      serialized !== null &&
      serialized.length <=
        SHARD_TARGET_CHARACTERS
    ) {
      files.push(
        await this.writeShard(
          serialized,
          context,
        ),
      );

      return;
    }

    if (
      end - start > 1
    ) {
      const middle =
        start +
        Math.floor(
          (end - start) /
            2,
        );

      await this.writeObjectRange(
        value,
        keys,
        start,
        middle,
        files,
        children,
        context,
      );

      await this.writeObjectRange(
        value,
        keys,
        middle,
        end,
        files,
        children,
        context,
      );

      return;
    }

    const key =
      keys[start];

    if (
      key === undefined
    ) {
      return;
    }

    children.push({
      key,
      node:
        await this.writeShardedNode(
          value[key],
          context,
        ),
    });
  }

  private async writeShard(
    serialized: string,
    context: ShardWriteContext,
  ): Promise<string> {
    const hash =
      await sha256(
        serialized,
      );

    const file =
      `${context.shardDirectory}/${hash}.json`;

    if (
      !(await this.adapter.exists(
        file,
      ))
    ) {
      await this.adapter.write(
        file,
        serialized,
      );

      context.writesSinceYield +=
        1;

      if (
        context.writesSinceYield >=
        SHARD_IO_YIELD_INTERVAL
      ) {
        context.writesSinceYield =
          0;

        await yieldPersistenceUi();
      }
    }

    if (
      !context.shardFiles.includes(
        file,
      )
    ) {
      context.shardFiles.push(
        file,
      );
    }

    return file;
  }

  private async readShardedNode(
    node: ShardNode,
    context: ShardReadContext,
  ): Promise<unknown> {
    switch (
      node.kind
    ) {
      case "inline":
        return node.value;

      case "undefined":
        return undefined;

      case "file":
        return this.readShardValue(
          node.file,
          context,
        );

      case "array": {
        const result =
          new Array<unknown>(
            node.length,
          );

        for (
          const part of
          node.files
        ) {
          const values =
            await this.readShardValue(
              part.file,
              context,
            );

          if (
            !Array.isArray(
              values,
            )
          ) {
            throw new Error(
              `Knowledge index shard "${part.file}" is not an array. Rebuild the index.`,
            );
          }

          for (
            let offset = 0;
            offset < values.length;
            offset += 1
          ) {
            result[
              part.start +
                offset
            ] =
              values[offset];
          }
        }

        for (
          const child of
          node.children
        ) {
          result[
            child.index
          ] =
            await this.readShardedNode(
              child.node,
              context,
            );
        }

        return result;
      }

      case "object": {
        const result:
          Record<
            string,
            unknown
          > = {};

        for (
          const file of
          node.files
        ) {
          const value =
            await this.readShardValue(
              file,
              context,
            );

          if (
            !isRecord(
              value,
            )
          ) {
            throw new Error(
              `Knowledge index shard "${file}" is not an object. Rebuild the index.`,
            );
          }

          Object.assign(
            result,
            value,
          );
        }

        for (
          const child of
          node.children
        ) {
          result[
            child.key
          ] =
            await this.readShardedNode(
              child.node,
              context,
            );
        }

        return result;
      }
    }
  }

  private async readShardValue(
    file: string,
    context: ShardReadContext,
  ): Promise<unknown> {
    if (
      !(await this.adapter
        .exists(file))
    ) {
      throw new Error(
        `Knowledge index shard "${file}" is missing. Rebuild the index.`,
      );
    }

    const serialized =
      await this.adapter.read(
        file,
      );

    const value =
      JSON.parse(
        serialized,
      );

    context.readsSinceYield +=
      1;

    if (
      context.readsSinceYield >=
      SHARD_IO_YIELD_INTERVAL
    ) {
      context.readsSinceYield =
        0;

      await yieldPersistenceUi();
    }

    return value;
  }

  private getShardDirectory():
    string {
    const slash =
      this.indexPath
        .lastIndexOf(
          "/",
        );

    const parent =
      slash >= 0
        ? this.indexPath.slice(
            0,
            slash,
          )
        : "";

    return parent
      ? `${parent}/knowledge-index-shards`
      : "knowledge-index-shards";
  }

  private async ensureDirectory(
    path: string,
  ): Promise<void> {
    if (
      await this.adapter.exists(
        path,
      )
    ) {
      return;
    }

    await this.adapter.mkdir(
      path,
    );
  }

  private async cleanupOldShards(
    keep: Set<string>,
  ): Promise<void> {
    const shardDirectory =
      this.getShardDirectory();

    try {
      if (
        !(await this.adapter
          .exists(
            shardDirectory,
          ))
      ) {
        return;
      }

      const listing =
        await this.adapter.list(
          shardDirectory,
        );

      for (
        const file of
        listing.files
      ) {
        if (
          keep.has(file)
        ) {
          continue;
        }

        try {
          await this.adapter.remove(
            file,
          );
        } catch (error) {
          console.warn(
            `[Local Vault AI] Could not remove stale knowledge-index shard "${file}".`,
            error,
          );
        }
      }
    } catch (error) {
      /*
       * Cleanup is best effort. Never invalidate a successfully saved
       * snapshot just because stale files could not be removed.
       */
      console.warn(
        "[Local Vault AI] Could not clean stale knowledge-index shards.",
        error,
      );
    }
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

    this.dirty = true;
  }

  async addMany(
    chunks: VaultChunk[],
  ): Promise<void> {
    this.assertReady();

    if (chunks.length === 0) {
      return;
    }

    /*
     * Rebuild recovery can occasionally encounter a runtime Orama snapshot
     * that contains a chunk whose manifest entry was not durably committed
     * (for example, if a previous save was interrupted between the index
     * snapshot and manifest writes). Treat chunk insertion as idempotent:
     * normally this is still one fast insertMultiple call, but if Orama
     * reports an existing id we remove every id in the attempted batch and
     * retry it once. This also clears any partial inserts made by the failed
     * insertMultiple call before retrying.
     */
    try {
      await insertMultiple(
        this.db,
        chunks as any[],
      );
    } catch (error) {
      if (
        !isDuplicateDocumentError(
          error,
        )
      ) {
        throw error;
      }

      for (const chunk of chunks) {
        try {
          await remove(
            this.db,
            chunk.id,
          );
        } catch {
          /*
           * Missing ids are expected here because the failed batch may
           * contain a mix of old and newly inserted documents.
           */
        }
      }

      await insertMultiple(
        this.db,
        chunks as any[],
      );
    }

    this.dirty = true;
  }

  async getMany(
    ids: string[],
  ): Promise<VaultChunk[]> {
    this.assertReady();

    const chunks:
      VaultChunk[] = [];

    for (
      let offset = 0;
      offset < ids.length;
      offset += 128
    ) {
      const batch =
        ids.slice(
          offset,
          offset + 128,
        );

      const documents =
        await Promise.all(
          batch.map(
            async (id) =>
              getByID(
                this.db,
                id,
              ),
          ),
        );

      for (const document of documents) {
        if (document) {
          chunks.push(
            document as unknown as VaultChunk,
          );
        }
      }

      if (
        offset + 128 <
        ids.length
      ) {
        await yieldPersistenceUi();
      }
    }

    return chunks;
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

      this.dirty = true;
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

    const mapped =
      (
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
        );

    /*
     * DEFENSE IN DEPTH:
     *
     * Orama is already asked to enforce sourceKey +
     * sectionKey with exact enum filters above.
     *
     * Do not trust a search backend result blindly for an
     * explicit-section request, though. Validate BOTH the
     * source path and the normalized section number again
     * in TypeScript before returning a chunk to RAG.
     *
     * This prevents a malformed/stale index or unexpected
     * search behavior from allowing unrelated sections to
     * reach the generation model.
     */
    const validated =
      mapped.filter(
        (
          chunk:
            RetrievedChunk,
        ) =>
          chunk.filePath ===
            sourcePath &&
          normalizeSectionNumber(
            chunk.sectionNumber,
          ) ===
            normalizedSection,
      );

    return validated
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


function isShardedIndexManifest(
  value: unknown,
): value is ShardedIndexManifest {
  if (
    !isRecord(value)
  ) {
    return false;
  }

  const knownFormat =
    (
      value.format ===
        SHARDED_INDEX_FORMAT &&
      value.version ===
        SHARDED_INDEX_VERSION
    ) ||
    (
      value.format ===
        LEGACY_SHARDED_INDEX_FORMAT &&
      value.version ===
        LEGACY_SHARDED_INDEX_VERSION
    );

  return (
    knownFormat &&
    typeof value.dimensions ===
      "number" &&
    typeof value.generation ===
      "string" &&
    Array.isArray(
      value.shardFiles,
    ) &&
    isRecord(
      value.root,
    )
  );
}

function isRecord(
  value: unknown,
): value is Record<
  string,
  unknown
> {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function serializeForShard(
  value: unknown,
): string {
  const serialized =
    JSON.stringify(
      value,
    );

  if (
    serialized === undefined
  ) {
    return "null";
  }

  return serialized;
}

function trySerializeForShard(
  value: unknown,
): string | null {
  try {
    return serializeForShard(
      value,
    );
  } catch (error) {
    if (
      isStringLengthError(
        error,
      )
    ) {
      return null;
    }

    throw error;
  }
}

function isStringLengthError(
  error: unknown,
): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const normalized =
    message.toLowerCase();

  return (
    normalized.includes(
      "invalid string length",
    ) ||
    normalized.includes(
      "string longer than",
    ) ||
    normalized.includes(
      "err_string_too_long",
    )
  );
}

function createShardGeneration():
  string {
  return (
    `${Date.now().toString(36)}-` +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

async function yieldPersistenceUi():
  Promise<void> {
  await new Promise<void>(
    (resolve) => {
      window.setTimeout(
        resolve,
        0,
      );
    },
  );
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

function isDuplicateDocumentError(
  error: unknown,
): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const normalized =
    message.toLowerCase();

  return (
    normalized.includes(
      "already exists",
    ) &&
    normalized.includes(
      "document",
    )
  );
}
