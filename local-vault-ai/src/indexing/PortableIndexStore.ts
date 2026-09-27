import {
  DataAdapter,
  normalizePath,
} from "obsidian";
import type {
  EmbeddingDescriptor,
  EmbeddingProvider,
} from "../embeddings/EmbeddingService";
import type {
  SourceType,
  VaultChunk,
} from "../types";
import {
  sha256,
} from "./Hash";

const PORTABLE_INDEX_FORMAT =
  "local-vault-ai-portable-index-v1";

const PORTABLE_INDEX_VERSION =
  1;

const PORTABLE_OBJECT_FORMAT =
  "local-vault-ai-portable-chunks-v1";

const PORTABLE_OBJECT_VERSION =
  1;

/*
 * Keep each immutable object reasonably small for Git/GitHub while avoiding
 * one JSON file per chunk. A typical Markdown source fits in one object and a
 * large PDF is split into stable groups of 64 chunks.
 */
const PORTABLE_OBJECT_CHUNK_COUNT =
  64;

const PORTABLE_IO_YIELD_INTERVAL =
  4;

const GITIGNORE_BEGIN =
  "# BEGIN Local Vault AI generated runtime cache";

const GITIGNORE_END =
  "# END Local Vault AI generated runtime cache";

const GITIGNORE_BLOCK = [
  GITIGNORE_BEGIN,
  "knowledge-index.json",
  "knowledge-index-shards/",
  "index-manifest.json",
  "index-rebuild-state.json",
  "local-embeddings/",
  "indexer-events.log",
  "indexer-events.1.log",
  GITIGNORE_END,
].join("\n");

export interface PortableSourceSnapshot {
  sourceHash: string;
  sourceType: SourceType;
  fileName: string;
  title: string;
  pageCount?: number;
  chunks: PortableCachedChunk[];
}

export type PortableCachedChunk =
  Omit<VaultChunk, "mtime">;

/*
 * Embeddings dominate the size of a portable index. JSON number arrays are
 * extremely verbose, so immutable Git objects store the same vectors as
 * base64-encoded Float32 bytes. The active runtime index still receives the
 * normal number[] representation expected by Orama.
 */
interface PortableStoredChunk
  extends Omit<
    PortableCachedChunk,
    "embedding"
  > {
  embeddingF32: string;
}

interface PortableSourceEntry {
  sourceHash: string;
  sourceType: SourceType;
  fileName: string;
  title: string;
  pageCount?: number;
  chunkCount: number;
  objectHashes: string[];
}

interface PortableIndexManifest {
  format:
    typeof PORTABLE_INDEX_FORMAT;
  version:
    typeof PORTABLE_INDEX_VERSION;
  indexVersion: number;
  embeddingProvider:
    EmbeddingProvider;
  embeddingIdentity: string;
  embeddingDimensions: number;
  indexPdfSources: boolean;
  createdAt: string;
  updatedAt: string;
  sources: Record<
    string,
    PortableSourceEntry
  >;
}

interface PortableChunkObject {
  format:
    typeof PORTABLE_OBJECT_FORMAT;
  version:
    typeof PORTABLE_OBJECT_VERSION;
  chunks:
    PortableStoredChunk[];
}

export class PortableIndexStore {
  private readonly portableDir:
    string;

  private readonly objectsDir:
    string;

  private readonly manifestPath:
    string;

  private readonly gitIgnorePath:
    string;

  private manifest:
    PortableIndexManifest | null =
      null;

  private dirty = false;

  private initialized = false;

  private mutationChain:
    Promise<void> =
      Promise.resolve();

  constructor(
    private readonly adapter:
      DataAdapter,
    dataDir: string,
  ) {
    this.portableDir =
      normalizePath(
        dataDir
          ? `${dataDir}/portable-index`
          : "portable-index",
      );

    this.objectsDir =
      normalizePath(
        `${this.portableDir}/objects`,
      );

    this.manifestPath =
      normalizePath(
        `${this.portableDir}/manifest.json`,
      );

    this.gitIgnorePath =
      normalizePath(
        dataDir
          ? `${dataDir}/.gitignore`
          : ".gitignore",
      );
  }

  async initialize():
    Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.ensureDirectory(
      this.portableDir,
    );

    await this.ensureDirectory(
      this.objectsDir,
    );

    await this.ensureRuntimeGitIgnore();
    await this.load();

    this.initialized = true;
  }

  hasManifest(): boolean {
    return this.manifest !==
      null;
  }

  isCompatible(
    descriptor:
      EmbeddingDescriptor,
    dimensions: number,
    indexVersion: number,
    indexPdfSources: boolean,
  ): boolean {
    const manifest =
      this.manifest;

    if (!manifest) {
      return false;
    }

    return (
      manifest.indexVersion ===
        indexVersion &&
      manifest.embeddingProvider ===
        descriptor.provider &&
      manifest.embeddingIdentity ===
        descriptor.identity &&
      manifest.embeddingDimensions ===
        dimensions &&
      manifest.indexPdfSources ===
        indexPdfSources
    );
  }

  async prepareProfile(
    descriptor:
      EmbeddingDescriptor,
    dimensions: number,
    indexVersion: number,
    indexPdfSources: boolean,
  ): Promise<void> {
    await this.waitForMutations();

    if (
      this.isCompatible(
        descriptor,
        dimensions,
        indexVersion,
        indexPdfSources,
      )
    ) {
      return;
    }

    const now =
      new Date()
        .toISOString();

    this.manifest = {
      format:
        PORTABLE_INDEX_FORMAT,
      version:
        PORTABLE_INDEX_VERSION,
      indexVersion,
      embeddingProvider:
        descriptor.provider,
      embeddingIdentity:
        descriptor.identity,
      embeddingDimensions:
        dimensions,
      indexPdfSources,
      createdAt: now,
      updatedAt: now,
      sources: {},
    };

    this.dirty = true;
  }

  hasSource(
    sourcePath: string,
    sourceHash: string,
  ): boolean {
    const entry =
      this.manifest
        ?.sources[
          sourcePath
        ];

    return (
      entry?.sourceHash ===
      sourceHash
    );
  }

  async loadSource(
    sourcePath: string,
    sourceHash: string,
  ): Promise<
    PortableSourceSnapshot | null
  > {
    await this.waitForMutations();

    const entry =
      this.manifest
        ?.sources[
          sourcePath
        ];

    if (
      !entry ||
      entry.sourceHash !==
        sourceHash
    ) {
      return null;
    }

    const chunks:
      PortableCachedChunk[] =
      [];

    let readsSinceYield = 0;

    for (
      const objectHash of
      entry.objectHashes
    ) {
      const objectPath =
        this.objectPath(
          objectHash,
        );

      if (
        !(await this.adapter
          .exists(
            objectPath,
          ))
      ) {
        console.warn(
          `[Local Vault AI] Portable index object is missing: ${objectPath}`,
        );

        return null;
      }

      try {
        const serialized =
          await this.adapter
            .read(
              objectPath,
            );

        const parsed =
          JSON.parse(
            serialized,
          );

        if (
          !isPortableChunkObject(
            parsed,
          )
        ) {
          console.warn(
            `[Local Vault AI] Portable index object is invalid: ${objectPath}`,
          );

          return null;
        }

        for (
          const chunk of
          parsed.chunks
        ) {
          if (
            chunk.filePath !==
              sourcePath ||
            chunk.sourceKey !==
              sourcePath
          ) {
            console.warn(
              `[Local Vault AI] Portable index object ${objectPath} belongs to a different source.`,
            );

            return null;
          }

          const restored =
            fromPortableStoredChunk(
              chunk,
            );

          if (
            restored.embedding.length !==
            this.manifest
              ?.embeddingDimensions
          ) {
            console.warn(
              `[Local Vault AI] Portable index object ${objectPath} has an incompatible embedding dimension.`,
            );

            return null;
          }

          chunks.push(
            restored,
          );
        }
      } catch (error) {
        console.warn(
          `[Local Vault AI] Could not read portable index object ${objectPath}.`,
          error,
        );

        return null;
      }

      readsSinceYield +=
        1;

      if (
        readsSinceYield >=
        PORTABLE_IO_YIELD_INTERVAL
      ) {
        readsSinceYield = 0;
        await yieldPortableIo();
      }
    }

    if (
      chunks.length !==
      entry.chunkCount
    ) {
      console.warn(
        `[Local Vault AI] Portable source ${sourcePath} expected ${entry.chunkCount} chunks but loaded ${chunks.length}.`,
      );

      return null;
    }

    return {
      sourceHash:
        entry.sourceHash,
      sourceType:
        entry.sourceType,
      fileName:
        entry.fileName,
      title:
        entry.title,
      pageCount:
        entry.pageCount,
      chunks,
    };
  }

  async putSource(
    sourcePath: string,
    sourceHash: string,
    sourceType:
      SourceType,
    fileName: string,
    title: string,
    pageCount: number | undefined,
    chunks: VaultChunk[],
  ): Promise<void> {
    const operation =
      this.mutationChain
        .catch(() => {})
        .then(
          async () => {
            if (!this.manifest) {
              throw new Error(
                "Portable index profile is not initialized.",
              );
            }

            const objectHashes:
              string[] = [];

            let writesSinceYield = 0;

            for (
              let offset = 0;
              offset <
              chunks.length;
              offset +=
              PORTABLE_OBJECT_CHUNK_COUNT
            ) {
              const portableChunks =
                chunks
                  .slice(
                    offset,
                    offset +
                      PORTABLE_OBJECT_CHUNK_COUNT,
                  )
                  .map(
                    toPortableStoredChunk,
                  );

              const payload:
                PortableChunkObject = {
                format:
                  PORTABLE_OBJECT_FORMAT,
                version:
                  PORTABLE_OBJECT_VERSION,
                chunks:
                  portableChunks,
              };

              const serialized =
                JSON.stringify(
                  payload,
                );

              const objectHash =
                await sha256(
                  serialized,
                );

              const objectPath =
                this.objectPath(
                  objectHash,
                );

              if (
                !(await this.adapter
                  .exists(
                    objectPath,
                  ))
              ) {
                await this.adapter
                  .write(
                    objectPath,
                    serialized,
                  );

                writesSinceYield +=
                  1;

                if (
                  writesSinceYield >=
                  PORTABLE_IO_YIELD_INTERVAL
                ) {
                  writesSinceYield = 0;
                  await yieldPortableIo();
                }
              }

              objectHashes.push(
                objectHash,
              );
            }

            const nextEntry:
              PortableSourceEntry = {
              sourceHash,
              sourceType,
              fileName,
              title,
              pageCount,
              chunkCount:
                chunks.length,
              objectHashes,
            };

            const existing =
              this.manifest
                .sources[
                  sourcePath
                ];

            if (
              portableSourceEntryEqual(
                existing,
                nextEntry,
              )
            ) {
              return;
            }

            this.manifest
              .sources[
                sourcePath
              ] =
              nextEntry;

            this.dirty = true;
          },
        );

    this.mutationChain =
      operation;

    await operation;
  }

  removeSource(
    sourcePath: string,
  ): void {
    const manifest =
      this.manifest;

    if (
      !manifest ||
      !manifest.sources[
        sourcePath
      ]
    ) {
      return;
    }

    delete manifest.sources[
      sourcePath
    ];

    this.dirty = true;
  }

  retainSources(
    sourcePaths: Set<string>,
  ): number {
    const manifest =
      this.manifest;

    if (!manifest) {
      return 0;
    }

    let removed = 0;

    for (
      const sourcePath of
      Object.keys(
        manifest.sources,
      )
    ) {
      if (
        sourcePaths.has(
          sourcePath,
        )
      ) {
        continue;
      }

      delete manifest.sources[
        sourcePath
      ];

      removed += 1;
    }

    if (removed > 0) {
      this.dirty = true;
    }

    return removed;
  }

  async save():
    Promise<void> {
    await this.waitForMutations();

    if (
      !this.manifest ||
      !this.dirty
    ) {
      return;
    }

    this.manifest.updatedAt =
      new Date()
        .toISOString();

    /*
     * Source workers finish in nondeterministic order. Sort source paths
     * before writing so two machines with identical content produce the
     * same manifest ordering instead of noisy Git diffs.
     */
    const sortedSources =
      Object.fromEntries(
        Object.entries(
          this.manifest
            .sources,
        ).sort(
          ([left], [right]) =>
            left.localeCompare(
              right,
            ),
        ),
      );

    const snapshot:
      PortableIndexManifest = {
      ...this.manifest,
      sources:
        sortedSources,
    };

    await this.adapter.write(
      this.manifestPath,
      JSON.stringify(
        snapshot,
        null,
        2,
      ),
    );

    this.manifest =
      snapshot;

    this.dirty = false;
  }

  getSourceCount(): number {
    return Object.keys(
      this.manifest
        ?.sources ??
        {},
    ).length;
  }

  private async load():
    Promise<void> {
    this.manifest = null;
    this.dirty = false;

    if (
      !(await this.adapter
        .exists(
          this.manifestPath,
        ))
    ) {
      return;
    }

    try {
      const serialized =
        await this.adapter
          .read(
            this.manifestPath,
          );

      const parsed =
        JSON.parse(
          serialized,
        );

      if (
        !isPortableIndexManifest(
          parsed,
        )
      ) {
        console.warn(
          "[Local Vault AI] Ignoring an invalid portable-index manifest.",
        );

        return;
      }

      this.manifest =
        parsed;
    } catch (error) {
      console.warn(
        "[Local Vault AI] Could not load the portable-index manifest.",
        error,
      );
    }
  }

  private async waitForMutations():
    Promise<void> {
    await this.mutationChain;
  }

  private objectPath(
    objectHash: string,
  ): string {
    return normalizePath(
      `${this.objectsDir}/${objectHash}.json`,
    );
  }

  private async ensureRuntimeGitIgnore():
    Promise<void> {
    try {
      let existing = "";

      if (
        await this.adapter
          .exists(
            this.gitIgnorePath,
          )
      ) {
        existing =
          await this.adapter
            .read(
              this.gitIgnorePath,
            );
      }

      if (
        existing.includes(
          GITIGNORE_BEGIN,
        )
      ) {
        return;
      }

      const prefix =
        existing.length > 0 &&
        !existing.endsWith(
          "\n",
        )
          ? "\n\n"
          : existing.length > 0
            ? "\n"
            : "";

      await this.adapter.write(
        this.gitIgnorePath,
        `${existing}${prefix}${GITIGNORE_BLOCK}\n`,
      );
    } catch (error) {
      /*
       * Git integration is a convenience. Never make indexing fail because
       * a read-only vault/repository prevented us from writing .gitignore.
       */
      console.warn(
        "[Local Vault AI] Could not update data/.gitignore for runtime index files.",
        error,
      );
    }
  }

  private async ensureDirectory(
    path: string,
  ): Promise<void> {
    if (
      await this.adapter
        .exists(path)
    ) {
      return;
    }

    await this.adapter.mkdir(
      path,
    );
  }
}

function toPortableStoredChunk(
  chunk: VaultChunk,
): PortableStoredChunk {
  return {
    id:
      chunk.id,
    sourceKey:
      chunk.sourceKey,
    sourceType:
      chunk.sourceType,
    sectionKey:
      chunk.sectionKey,
    sourceSearchName:
      chunk.sourceSearchName,
    filePath:
      chunk.filePath,
    fileName:
      chunk.fileName,
    folder:
      chunk.folder,
    title:
      chunk.title,
    heading:
      chunk.heading,
    sectionNumber:
      chunk.sectionNumber,
    sectionTitle:
      chunk.sectionTitle,
    content:
      chunk.content,
    tags:
      chunk.tags,
    links:
      chunk.links,
    properties:
      chunk.properties,
    pageStart:
      chunk.pageStart,
    pageEnd:
      chunk.pageEnd,
    embeddingF32:
      encodeFloat32Base64(
        chunk.embedding,
      ),
  };
}

function fromPortableStoredChunk(
  chunk: PortableStoredChunk,
): PortableCachedChunk {
  const {
    embeddingF32,
    ...metadata
  } = chunk;

  return {
    ...metadata,
    embedding:
      decodeFloat32Base64(
        embeddingF32,
      ),
  };
}

const BASE64_BYTE_CHUNK =
  0x8000;

function encodeFloat32Base64(
  values: number[],
): string {
  const floats =
    new Float32Array(
      values,
    );

  const bytes =
    new Uint8Array(
      floats.buffer,
      floats.byteOffset,
      floats.byteLength,
    );

  let binary = "";

  for (
    let offset = 0;
    offset < bytes.length;
    offset +=
      BASE64_BYTE_CHUNK
  ) {
    binary +=
      String.fromCharCode(
        ...bytes.subarray(
          offset,
          Math.min(
            bytes.length,
            offset +
              BASE64_BYTE_CHUNK,
          ),
        ),
      );
  }

  return btoa(binary);
}

function decodeFloat32Base64(
  encoded: string,
): number[] {
  const binary =
    atob(encoded);

  if (
    binary.length % 4 !==
    0
  ) {
    throw new Error(
      "Portable embedding payload has an invalid byte length.",
    );
  }

  const bytes =
    new Uint8Array(
      binary.length,
    );

  for (
    let index = 0;
    index < binary.length;
    index += 1
  ) {
    bytes[index] =
      binary.charCodeAt(
        index,
      );
  }

  return Array.from(
    new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4,
    ),
  );
}

function portableSourceEntryEqual(
  left:
    PortableSourceEntry | undefined,
  right:
    PortableSourceEntry,
): boolean {
  if (!left) {
    return false;
  }

  if (
    left.sourceHash !==
      right.sourceHash ||
    left.sourceType !==
      right.sourceType ||
    left.fileName !==
      right.fileName ||
    left.title !==
      right.title ||
    left.pageCount !==
      right.pageCount ||
    left.chunkCount !==
      right.chunkCount ||
    left.objectHashes.length !==
      right.objectHashes.length
  ) {
    return false;
  }

  return left.objectHashes
    .every(
      (
        hash,
        index,
      ) =>
        hash ===
        right.objectHashes[
          index
        ],
    );
}

function isPortableIndexManifest(
  value: unknown,
): value is PortableIndexManifest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.format ===
      PORTABLE_INDEX_FORMAT &&
    value.version ===
      PORTABLE_INDEX_VERSION &&
    typeof value.indexVersion ===
      "number" &&
    (
      value.embeddingProvider ===
        "local" ||
      value.embeddingProvider ===
        "ollama"
    ) &&
    typeof value.embeddingIdentity ===
      "string" &&
    typeof value.embeddingDimensions ===
      "number" &&
    typeof value.indexPdfSources ===
      "boolean" &&
    typeof value.createdAt ===
      "string" &&
    typeof value.updatedAt ===
      "string" &&
    isRecord(
      value.sources,
    )
  );
}

function isPortableChunkObject(
  value: unknown,
): value is PortableChunkObject {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.format ===
      PORTABLE_OBJECT_FORMAT &&
    value.version ===
      PORTABLE_OBJECT_VERSION &&
    Array.isArray(
      value.chunks,
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

async function yieldPortableIo():
  Promise<void> {
  if (
    typeof MessageChannel !==
    "undefined"
  ) {
    await new Promise<void>(
      (resolve) => {
        const channel =
          new MessageChannel();

        channel.port1.onmessage =
          () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };

        channel.port2.postMessage(
          null,
        );
      },
    );

    return;
  }

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        0,
      );
    },
  );
}
