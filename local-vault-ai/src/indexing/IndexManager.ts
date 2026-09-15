import {
  App,
  TAbstractFile,
  TFile,
} from "obsidian";
import {
  LocalVaultAISettings,
} from "../settings/Settings";
import {
  OllamaClient,
} from "../ollama/OllamaClient";
import {
  ModelRuntimeManager,
  ModelUnloadPendingError,
} from "../ollama/ModelRuntimeManager";
import {
  KnowledgeIndex,
} from "../search/KnowledgeIndex";
import {
  EmbeddingServiceRouter,
} from "../embeddings/EmbeddingServiceRouter";
import {
  IndexStatus,
  SourceType,
  VaultChunk,
} from "../types";
import {
  normalizeSourceName,
} from "../retrieval/SourceResolver";
import {
  chunkMarkdown,
} from "./Chunker";
import {
  extractMetadata,
} from "./MetadataExtractor";
import {
  sha256,
  sha256Bytes,
} from "./Hash";
import {
  chunkPdfPages,
  PdfChunk,
} from "./PdfChunker";
import {
  extractPdf,
  PdfNoTextError,
} from "./PdfExtractor";
import {
  createEmptyManifest,
  INDEX_VERSION,
  IndexManifest,
  loadManifest,
  saveManifest,
} from "./IndexManifest";
import {
  AsyncSemaphore,
  runBoundedPool,
} from "./Concurrency";
import {
  FileSystemGate,
  FileSystemOperationError,
} from "./FileSystemGate";

const PERSIST_DEBOUNCE_MS =
  2200;

const NO_SECTION_KEY =
  "__none__";

const MIN_SOURCE_CONCURRENCY =
  1;

const MAX_SOURCE_CONCURRENCY =
  8;

const MIN_FILESYSTEM_CONCURRENCY =
  1;

const MAX_FILESYSTEM_CONCURRENCY =
  4;

const MIN_PDF_PAGE_CONCURRENCY =
  1;

const MAX_PDF_PAGE_CONCURRENCY =
  16;

const MIN_EMBEDDING_BATCH_SIZE =
  4;

const MAX_EMBEDDING_BATCH_SIZE =
  128;

const MIN_EMBEDDING_CONCURRENCY =
  1;

const MAX_EMBEDDING_CONCURRENCY =
  6;

interface PreparedChunk {
  heading: string;
  sectionNumber: string;
  sectionTitle: string;
  content: string;
  index: number;
  pageStart: number;
  pageEnd: number;
}

interface EmbeddedChunk
  extends PreparedChunk {
  embedding: number[];
}

interface SourceInfo {
  sourceType: SourceType;
  title: string;
  tags: string[];
  links: string[];
  properties: string[];
  pageCount?: number;
}

interface PreparedDocument {
  file: TFile;
  fileHash: string;
  source: SourceInfo;
  chunks: EmbeddedChunk[];
}

interface RebuildProgress {
  totalSources: number;
  completedSources: number;

  activeSources:
    Set<string>;

  activePdfPages:
    number;

  completedPdfPages:
    number;

  knownPdfPages:
    number;

  activeEmbeddingRequests:
    number;

  knownChunks:
    number;

  embeddedChunks:
    number;

  markdownCompleted:
    number;

  pdfCompleted:
    number;

  skippedPdfs:
    number;
}

export class IndexManager {
  private readonly app:
    App;

  private readonly settings:
    LocalVaultAISettings;

  private readonly ollama:
    OllamaClient;

  /*
   * Embedding-only router. This never handles chat or
   * lecture generation.
   */
  private readonly embeddings:
    EmbeddingServiceRouter;

  private readonly knowledgeIndex:
    KnowledgeIndex;

  private readonly manifestPath:
    string;

  /*
   * Optional for backward compatibility with the
   * pre-runtime-lease IndexManager constructor.
   */
  private readonly modelRuntime:
    ModelRuntimeManager | null;

  private manifest:
    IndexManifest | null =
    null;

  private status:
    IndexStatus = {
      state:
        "uninitialized",

      message:
        "Index has not been initialized.",

      documentCount: 0,
      chunkCount: 0,
      lastIndexedAt: null,
    };

  private readonly listeners =
    new Set<
      (
        status:
          IndexStatus,
      ) => void
    >();

  private readonly fileTimers =
    new Map<
      string,
      number
    >();

  /*
   * Orama mutations and persistence remain
   * serialized even when preparation/embedding
   * happens concurrently.
   */
  private readonly commitSemaphore =
    new AsyncSemaphore(1);

  /*
   * Actual vault/plugin filesystem I/O is throttled
   * separately from source preparation. This allows
   * PDF extraction/chunking/embedding to overlap
   * without issuing too many adapter reads/writes.
   */
  private readonly fileSystem:
    FileSystemGate;

  private persistTimer:
    number | null = null;

  private persistInFlight:
    Promise<void> | null =
    null;

  constructor(
    app: App,
    settings:
      LocalVaultAISettings,
    ollama:
      OllamaClient,
    modelRuntime:
      ModelRuntimeManager,
    embeddings:
      EmbeddingServiceRouter,
    knowledgeIndex:
      KnowledgeIndex,
    manifestPath:
      string,
  ) {
    this.app = app;
    this.settings =
      settings;
    this.ollama =
      ollama;
    this.modelRuntime =
      modelRuntime;
    this.embeddings =
      embeddings;
    this.knowledgeIndex =
      knowledgeIndex;
    this.manifestPath =
      manifestPath;

    this.fileSystem =
      new FileSystemGate(
        this.filesystemConcurrency(),
      );
  }

  async initialize():
    Promise<void> {
    try {
      this.manifest =
        await this.fileSystem
          .run(
            "loading index manifest",
            this.manifestPath,
            async () =>
              loadManifest(
                this.app.vault
                  .adapter,
                this.manifestPath,
              ),
          );

      if (!this.manifest) {
        this.setStatus(
          "needs-rebuild",
          "No knowledge index exists yet. Rebuild the index.",
        );

        return;
      }

      if (
        this.manifest
          .version !==
        INDEX_VERSION
      ) {
        this.setStatus(
          "needs-rebuild",
          "The index format changed. Rebuild the index.",
        );

        return;
      }

const activeEmbedding =
  this.embeddings
    .getDescriptor();

if (
  this.manifest
    .embeddingProvider !==
    activeEmbedding
      .provider ||
  this.manifest
    .embeddingIdentity !==
    activeEmbedding
      .identity
) {
  this.setStatus(
    "needs-rebuild",
    `The knowledge index was built with "${this.manifest.embeddingIdentity}", ` +
      `but the active embedding backend is "${activeEmbedding.identity}". ` +
      "Rebuild the index before searching.",
  );

  return;
}

      if (
        this.manifestPdfSetting() !==
        this.settings
          .indexPdfSources
      ) {
        this.setStatus(
          "needs-rebuild",
          this.settings
            .indexPdfSources
            ? "PDF/source indexing is enabled, but the current knowledge index was built in Markdown-only mode. Rebuild the index."
            : "PDF/source indexing is disabled, but the current knowledge index was built with PDF sources. Rebuild the index to create a Markdown-only index.",
        );

        return;
      }

      if (
        !(await this.fileSystem
          .run(
            "checking knowledge index",
            "knowledge-index.json",
            async () =>
              this.knowledgeIndex
                .existsOnDisk(),
          ))
      ) {
        this.setStatus(
          "needs-rebuild",
          "The index manifest exists, but the search index is missing. Rebuild the index.",
        );

        return;
      }

      await this.fileSystem
        .run(
          "loading knowledge index",
          "knowledge-index.json",
          async () =>
            this.knowledgeIndex
              .load(
                this.manifest!
                  .embeddingDimensions,
              ),
        );

      this.setStatus(
        "ready",
        "Knowledge index is ready.",
      );
    } catch (error) {
      this.setStatus(
        "error",
        this.errorText(
          error,
        ),
      );
    }
  }

  getStatus():
    IndexStatus {
    return {
      ...this.status,
    };
  }

  subscribe(
    listener:
      (
        status:
          IndexStatus,
      ) => void,
  ): () => void {
    this.listeners.add(
      listener,
    );

    listener(
      this.getStatus(),
    );

    return () => {
      this.listeners.delete(
        listener,
      );
    };
  }

  async onSettingsChanged():
    Promise<void> {
    this.ollama.setBaseUrl(
      this.settings
        .ollamaUrl,
    );

    /*
     * Future filesystem operations use the new limit.
     * Settings changes are not applied mid-rebuild.
     */
    this.fileSystem
      .setConcurrency(
        this.filesystemConcurrency(),
      );

if (
  this.manifest
) {
  const activeEmbedding =
    this.embeddings
      .getDescriptor();

  if (
    this.manifest
      .embeddingProvider !==
      activeEmbedding
        .provider ||
    this.manifest
      .embeddingIdentity !==
      activeEmbedding
        .identity
  ) {
    this.setStatus(
      "needs-rebuild",
      `Embedding backend changed to "${activeEmbedding.displayName}". ` +
        "Rebuild the knowledge index before searching.",
    );

    return;
  }

  if (
    this.manifestPdfSetting() !==
    this.settings
      .indexPdfSources
  ) {
    this.setStatus(
      "needs-rebuild",
      this.settings
        .indexPdfSources
        ? "PDF/source indexing was enabled. Rebuild the knowledge index to add eligible PDF sources."
        : "PDF/source indexing was disabled. Rebuild the knowledge index to remove previously indexed PDFs and create a Markdown-only index.",
    );
  }
}
  }

  async rebuildAll():
    Promise<void> {
    if (
      this.status.state ===
      "indexing"
    ) {
      throw new Error(
        "An index operation is already running.",
      );
    }

    let lease:
      ReturnType<
        ModelRuntimeManager[
          "acquireJob"
        ]
      > | null = null;

    try {
      const remoteEmbeddingModel =
        this.embeddings
          .getOllamaModelName();

      if (
        this.modelRuntime &&
        remoteEmbeddingModel
      ) {
        lease =
          this.modelRuntime
            .acquireJob({
              kind:
                "index-rebuild",

              label:
                "Rebuilding knowledge index",

              models: [
                remoteEmbeddingModel,
              ],
            });
      }

      const embeddingDescriptor =
        this.embeddings
          .getDescriptor();

      this.setStatus(
        "indexing",
        this.embeddings
          .usesLocalEmbeddings()
          ? "Preparing local embedding model..."
          : "Checking Ollama embedding model...",
      );

      await this.embeddings
        .validate();

      const dimensions =
        await this.embeddings
          .embeddingDimension();

      await this
        .knowledgeIndex
        .createEmpty(
          dimensions,
        );

      this.manifest =
        createEmptyManifest(
          embeddingDescriptor,
          dimensions,
        );

      /*
       * Persist the indexing mode with the manifest so
       * a later Obsidian restart can detect a settings
       * mismatch before loading stale PDF chunks.
       */
      this.manifest
        .indexPdfSources =
        this.settings
          .indexPdfSources;

      const files =
        this.app.vault
          .getFiles()
          .filter(
            (file) =>
              this.isIndexableFile(
                file,
              ),
          );

      const sourceConcurrency =
        this.sourceConcurrency();

      /*
       * One global limiter is shared by every active
       * PDF. Source workers may each schedule page
       * work, but only pdfPageConcurrency pages total
       * can be inside PDF.js extraction at once.
       */
      const pdfPageSemaphore =
        new AsyncSemaphore(
          this.pdfPageConcurrency(),
        );

      const embeddingSemaphore =
        new AsyncSemaphore(
          this.embeddingConcurrency(),
        );

      const progress:
        RebuildProgress = {
        totalSources:
          files.length,

        completedSources:
          0,

        activeSources:
          new Set<string>(),

        activePdfPages:
          0,

        completedPdfPages:
          0,

        knownPdfPages:
          0,

        activeEmbeddingRequests:
          0,

        knownChunks:
          0,

        embeddedChunks:
          0,

        markdownCompleted:
          0,

        pdfCompleted:
          0,

        skippedPdfs:
          0,
      };

      this.updateRebuildStatus(
        progress,
      );

      await runBoundedPool(
        files,
        sourceConcurrency,
        async (file) => {
          progress.activeSources
            .add(
              file.path,
            );

          this.updateRebuildStatus(
            progress,
          );

          try {
            const prepared =
              await this
                .prepareDocument(
                  file,
                  true,
                  pdfPageSemaphore,
                  embeddingSemaphore,
                  progress,
                );

            if (!prepared) {
              return;
            }

            /*
             * One serialized commit prevents multiple
             * source workers from mutating Orama or
             * the manifest simultaneously.
             */
            await this
              .commitSemaphore
              .run(
                async () => {
                  await this
                    .commitPreparedDocument(
                      prepared,
                    );
                },
              );

            if (
              prepared
                .source
                .sourceType ===
              "pdf"
            ) {
              progress
                .pdfCompleted +=
                1;
            } else {
              progress
                .markdownCompleted +=
                1;
            }
          } catch (error) {
            if (
              error instanceof
              PdfNoTextError
            ) {
              progress
                .skippedPdfs +=
                1;

              console.warn(
                `[Local Vault AI] ${error.message}`,
              );

              return;
            }

            throw error;
          } finally {
            progress.activeSources
              .delete(
                file.path,
              );

            progress
              .completedSources +=
              1;

            this.updateRebuildStatus(
              progress,
            );
          }
        },
      );

      /*
       * Full rebuild persistence remains one final
       * serialized save. We do not serialize the
       * whole Orama index after every PDF.
       */
      await this.persistNow();

      const skippedText =
        progress.skippedPdfs >
        0
          ? ` Skipped ${progress.skippedPdfs} PDF(s) with no extractable text.`
          : "";

      this.setStatus(
        "ready",
        this.settings
          .indexPdfSources
          ? (
              `Indexed ${progress.markdownCompleted} Markdown file(s) and ` +
              `${progress.pdfCompleted} PDF file(s).${skippedText}`
            )
          : (
              `Indexed ${progress.markdownCompleted} Markdown file(s). ` +
              "PDF/source indexing is disabled; this is a Markdown-only knowledge index."
            ),
      );
    } catch (error) {
      if (
        error instanceof
        FileSystemOperationError
      ) {
        this.setStatus(
          "error",
          error.message,
        );
      } else if (
        error instanceof
        ModelUnloadPendingError
      ) {
        this.setStatus(
          "needs-rebuild",
          error.message,
        );
      } else {
        this.setStatus(
          "error",
          this.errorText(
            error,
          ),
        );
      }

      throw error;
    } finally {
      if (lease) {
        await lease.release();
      }
    }
  }

  handleCreate(
    file: TAbstractFile,
  ): void {
    if (
      !this.isIndexableFile(
        file,
      )
    ) {
      return;
    }

    this.scheduleFile(file);
  }

  handleModify(
    file: TAbstractFile,
  ): void {
    if (
      !this.isIndexableFile(
        file,
      )
    ) {
      return;
    }

    this.scheduleFile(file);
  }

  handleRename(
    file: TAbstractFile,
    oldPath: string,
  ): void {
    if (
      !this.settings
        .autoIndex
    ) {
      return;
    }

    if (
      this.status.state !==
      "ready"
    ) {
      return;
    }

    const oldTimer =
      this.fileTimers.get(
        oldPath,
      );

    if (
      oldTimer !==
      undefined
    ) {
      window.clearTimeout(
        oldTimer,
      );

      this.fileTimers.delete(
        oldPath,
      );
    }

    void this
      .removeDocument(
        oldPath,
      )
      .then(
        async () => {
          if (
            this.isIndexableFile(
              file,
            )
          ) {
            await this
              .indexFile(file);
          }
        },
      );
  }

  handleDelete(
    file: TAbstractFile,
  ): void {
    if (
      !this.settings
        .autoIndex
    ) {
      return;
    }

    if (
      !this.isIndexableFile(
        file,
      )
    ) {
      return;
    }

    if (
      this.status.state !==
      "ready"
    ) {
      return;
    }

    const timer =
      this.fileTimers.get(
        file.path,
      );

    if (
      timer !==
      undefined
    ) {
      window.clearTimeout(
        timer,
      );

      this.fileTimers.delete(
        file.path,
      );
    }

    void this.removeDocument(
      file.path,
    );
  }

  async indexFile(
    file: TFile,
  ): Promise<void> {
    if (
      this.status.state !==
      "ready"
    ) {
      return;
    }

    if (
      !this.isIndexableFile(
        file,
      )
    ) {
      return;
    }

    let lease:
      ReturnType<
        ModelRuntimeManager[
          "acquireJob"
        ]
      > | null = null;

    try {
      const remoteEmbeddingModel =
        this.embeddings
          .getOllamaModelName();

      if (
        this.modelRuntime &&
        remoteEmbeddingModel
      ) {
        lease =
          this.modelRuntime
            .acquireJob({
              kind:
                "index-update",

              label:
                `Indexing ${file.path}`,

              models: [
                remoteEmbeddingModel,
              ],
            });
      }

      await this.embeddings
        .validate();

      /*
       * A single-file update can still parallelize
       * that document's embedding batches.
       */
      const pdfPageSemaphore =
        new AsyncSemaphore(
          this.pdfPageConcurrency(),
        );

      const embeddingSemaphore =
        new AsyncSemaphore(
          this.embeddingConcurrency(),
        );

      const prepared =
        await this.prepareDocument(
          file,
          false,
          pdfPageSemaphore,
          embeddingSemaphore,
          null,
        );

      if (!prepared) {
        return;
      }

      await this
        .commitSemaphore
        .run(
          async () => {
            await this
              .commitPreparedDocument(
                prepared,
              );
          },
        );

      this.schedulePersist();
      this.refreshStatusCounts();
    } catch (error) {
      if (
        error instanceof
        FileSystemOperationError
      ) {
        this.setStatus(
          "error",
          error.message,
        );

        return;
      }

      if (
        error instanceof
        PdfNoTextError
      ) {
        console.warn(
          `[Local Vault AI] ${error.message}`,
        );

        this.setStatus(
          "ready",
          error.message,
        );

        return;
      }

      if (
        error instanceof
        ModelUnloadPendingError
      ) {
        this.setStatus(
          "needs-rebuild",
          `Index update deferred for ${file.path} because the embedding model is unloading. ` +
            "Rebuild the index later or edit the source again after the model is available.",
        );

        return;
      }

      this.setStatus(
        "error",
        `Could not index ${file.path}: ${this.errorText(error)}`,
      );
    } finally {
      if (lease) {
        await lease.release();
      }
    }
  }

  async flush():
    Promise<void> {
    if (
      this.persistTimer !==
      null
    ) {
      window.clearTimeout(
        this.persistTimer,
      );

      this.persistTimer =
        null;
    }

    if (
      this.manifest &&
      this.knowledgeIndex
        .isReady()
    ) {
      await this.persistNow();
    }
  }

  dispose(): void {
    for (
      const timer of
      this.fileTimers.values()
    ) {
      window.clearTimeout(
        timer,
      );
    }

    this.fileTimers.clear();

    if (
      this.persistTimer !==
      null
    ) {
      window.clearTimeout(
        this.persistTimer,
      );

      this.persistTimer =
        null;
    }

    this.listeners.clear();
  }

  private scheduleFile(
    file: TFile,
  ): void {
    if (
      !this.settings
        .autoIndex
    ) {
      return;
    }

    if (
      this.status.state !==
      "ready"
    ) {
      return;
    }

    const current =
      this.fileTimers.get(
        file.path,
      );

    if (
      current !==
      undefined
    ) {
      window.clearTimeout(
        current,
      );
    }

    const timer =
      window.setTimeout(
        () => {
          this.fileTimers.delete(
            file.path,
          );

          void this
            .indexFile(file);
        },
        this.settings
          .modifyDebounceMs,
      );

    this.fileTimers.set(
      file.path,
      timer,
    );
  }

  private async prepareDocument(
    file: TFile,
    force: boolean,
    pdfPageSemaphore:
      AsyncSemaphore,
    embeddingSemaphore:
      AsyncSemaphore,
    progress:
      RebuildProgress | null,
  ): Promise<
    PreparedDocument | null
  > {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const extension =
      file.extension
        .toLowerCase();

    if (
      extension === "md"
    ) {
      return this
        .prepareMarkdownDocument(
          file,
          force,
          embeddingSemaphore,
          progress,
        );
    }

    if (
      extension === "pdf"
    ) {
      return this
        .preparePdfDocument(
          file,
          force,
          pdfPageSemaphore,
          embeddingSemaphore,
          progress,
        );
    }

    throw new Error(
      `Unsupported index source: ${file.path}`,
    );
  }

  private async prepareMarkdownDocument(
    file: TFile,
    force: boolean,
    embeddingSemaphore:
      AsyncSemaphore,
    progress:
      RebuildProgress | null,
  ): Promise<
    PreparedDocument | null
  > {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const markdown =
      await this.fileSystem
        .run(
          "reading Markdown source",
          file.path,
          async () =>
            this.app.vault
              .cachedRead(file),
        );

    const fileHash =
      await sha256(
        markdown,
      );

    const existing =
      this.manifest
        .documents[
        file.path
      ];

    if (
      !force &&
      existing?.hash ===
        fileHash
    ) {
      return null;
    }

    const metadata =
      extractMetadata(
        this.app,
        file,
      );

    const chunks:
      PreparedChunk[] =
      chunkMarkdown(
        markdown,
      ).map(
        (chunk) => ({
          heading:
            chunk.heading,

          sectionNumber:
            "",

          sectionTitle:
            "",

          content:
            chunk.content,

          index:
            chunk.index,

          pageStart: 0,
          pageEnd: 0,
        }),
      );

    const source:
      SourceInfo = {
      sourceType:
        "markdown",

      title:
        file.basename,

      tags:
        metadata.tags,

      links:
        metadata.links,

      properties:
        metadata.properties,
    };

    const embeddedChunks =
      await this
        .embedChunks(
          file,
          source,
          chunks,
          embeddingSemaphore,
          progress,
        );

    return {
      file,
      fileHash,
      source,
      chunks:
        embeddedChunks,
    };
  }

  private async preparePdfDocument(
    file: TFile,
    force: boolean,
    pdfPageSemaphore:
      AsyncSemaphore,
    embeddingSemaphore:
      AsyncSemaphore,
    progress:
      RebuildProgress | null,
  ): Promise<
    PreparedDocument | null
  > {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const buffer =
      await this.fileSystem
        .run(
          "reading PDF source",
          file.path,
          async () =>
            this.app.vault
              .readBinary(file),
        );

    const bytes =
      new Uint8Array(
        buffer,
      );

    const fileHash =
      await sha256Bytes(
        bytes,
      );

    const existing =
      this.manifest
        .documents[
        file.path
      ];

    if (
      !force &&
      existing?.hash ===
        fileHash
    ) {
      return null;
    }

    /*
     * Extraction remains local to the desktop.
     * Several source workers may interleave PDF
     * extraction, while embedding requests are
     * independently bounded by the global semaphore.
     */
    let lastKnownPageCount = 0;

    const extracted =
      await extractPdf(
        bytes,
        file.name,
        {
          /*
           * A PDF gets up to the configured number of
           * local page workers, but every PDF shares
           * the same global semaphore.
           */
          pageConcurrency:
            this.pdfPageConcurrency(),

          pageSemaphore:
            pdfPageSemaphore,

          onProgress:
            progress
              ? (
                  pdfProgress,
                ) => {
                  /*
                   * Each active PDF reports its full
                   * page count repeatedly. Add it only
                   * once for this document.
                   */
                  if (
                    lastKnownPageCount ===
                    0
                  ) {
                    lastKnownPageCount =
                      pdfProgress
                        .pageCount;

                    progress
                      .knownPdfPages +=
                      pdfProgress
                        .pageCount;
                  }

                  /*
                   * The shared semaphore's active count
                   * is the authoritative GLOBAL number,
                   * rather than summing per-PDF values.
                   */
                  progress
                    .activePdfPages =
                    pdfPageSemaphore
                      .getActiveCount();

                  /*
                   * PdfExtractor's completedPages value
                   * is per-document. We update the
                   * aggregate after extraction completes
                   * below, avoiding double counting.
                   */
                  this.updateRebuildStatus(
                    progress,
                  );
                }
              : undefined,
        },
      );

    if (progress) {
      progress.completedPdfPages +=
        extracted.pageCount;

      progress.activePdfPages =
        pdfPageSemaphore
          .getActiveCount();

      this.updateRebuildStatus(
        progress,
      );
    }

    const pdfChunks:
      PdfChunk[] =
      chunkPdfPages(
        extracted.pages,
      );

    if (
      pdfChunks.length ===
      0
    ) {
      throw new PdfNoTextError(
        file.name,
      );
    }

    const chunks:
      PreparedChunk[] =
      pdfChunks.map(
        (chunk) => ({
          heading:
            chunk.heading,

          sectionNumber:
            chunk.sectionNumber,

          sectionTitle:
            chunk.sectionTitle,

          content:
            chunk.content,

          index:
            chunk.index,

          pageStart:
            chunk.pageStart,

          pageEnd:
            chunk.pageEnd,
        }),
      );

    const source:
      SourceInfo = {
      sourceType:
        "pdf",

      title:
        extracted.title ??
        file.basename,

      tags: [],
      links: [],
      properties: [],

      pageCount:
        extracted.pageCount,
    };

    const embeddedChunks =
      await this
        .embedChunks(
          file,
          source,
          chunks,
          embeddingSemaphore,
          progress,
        );

    return {
      file,
      fileHash,
      source,
      chunks:
        embeddedChunks,
    };
  }

  private async embedChunks(
    file: TFile,
    source:
      SourceInfo,
    chunks:
      PreparedChunk[],
    embeddingSemaphore:
      AsyncSemaphore,
    progress:
      RebuildProgress | null,
  ): Promise<
    EmbeddedChunk[]
  > {
    if (
      chunks.length === 0
    ) {
      return [];
    }

    const batchSize =
      this.embeddingBatchSize();

    if (progress) {
      progress.knownChunks +=
        chunks.length;

      this.updateRebuildStatus(
        progress,
      );
    }

    const batches:
      Array<{
        start: number;
        chunks:
          PreparedChunk[];
      }> = [];

    for (
      let offset = 0;
      offset <
      chunks.length;
      offset +=
      batchSize
    ) {
      batches.push({
        start:
          offset,

        chunks:
          chunks.slice(
            offset,
            offset +
              batchSize,
          ),
      });
    }

    /*
     * All batches may be scheduled here, but the
     * shared semaphore guarantees that no more than
     * embeddingConcurrency are actually in flight
     * across every active source worker.
     *
     * Promise.all preserves the original batch order.
     */
    const embeddedBatches =
      await Promise.all(
        batches.map(
          async (
            batch,
          ): Promise<
            EmbeddedChunk[]
          > =>
            embeddingSemaphore
              .run(
                async () => {
                  if (progress) {
                    progress
                      .activeEmbeddingRequests +=
                      1;

                    this.updateRebuildStatus(
                      progress,
                    );
                  }

                  try {
                    const inputs =
                      batch.chunks
                        .map(
                          (chunk) =>
                            this.embeddingText(
                              file,
                              source,
                              chunk,
                            ),
                        );

                    const embeddings =
                      await this.embeddings
                        .embed(
                          inputs,
                        );

                    if (
                      embeddings.length !==
                      batch.chunks
                        .length
                    ) {
                      throw new Error(
                        `Embedding count mismatch for ${file.path}.`,
                      );
                    }

                    const results:
                      EmbeddedChunk[] =
                      [];

                    for (
                      let index = 0;
                      index <
                      batch.chunks
                        .length;
                      index += 1
                    ) {
                      const chunk =
                        batch.chunks[
                          index
                        ];

                      const embedding =
                        embeddings[
                          index
                        ];

                      if (
                        !chunk ||
                        !embedding
                      ) {
                        continue;
                      }

                      results.push({
                        ...chunk,
                        embedding,
                      });
                    }

                    if (progress) {
                      progress
                        .embeddedChunks +=
                        results.length;
                    }

                    return results;
                  } finally {
                    if (progress) {
                      progress
                        .activeEmbeddingRequests =
                        Math.max(
                          0,
                          progress
                            .activeEmbeddingRequests -
                            1,
                        );

                      this.updateRebuildStatus(
                        progress,
                      );
                    }
                  }
                },
              ),
        ),
      );

    return embeddedBatches
      .flat();
  }

  private async commitPreparedDocument(
    prepared:
      PreparedDocument,
  ): Promise<void> {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const {
      file,
      fileHash,
      source,
      chunks,
    } =
      prepared;

    const existing =
      this.manifest
        .documents[
        file.path
      ];

    if (existing) {
      await this
        .knowledgeIndex
        .removeMany(
          existing.chunkIds,
        );
    }

    const chunkIds:
      string[] = [];

    const sourceSearchName =
      [
        normalizeSourceName(
          file.basename,
        ),

        normalizeSourceName(
          source.title,
        ),
      ]
        .filter(Boolean)
        .join(" ");

    for (
      const chunk of
      chunks
    ) {
      const id =
        this.chunkId(
          file.path,
          chunk.index,
        );

      const folder =
        file.parent?.path ===
        "/"
          ? ""
          : file.parent
              ?.path ??
            "";

      const vaultChunk:
        VaultChunk = {
        id,

        sourceKey:
          file.path,

        sourceType:
          source.sourceType,

        sourceSearchName,

        sectionKey:
          chunk.sectionNumber ||
          NO_SECTION_KEY,

        filePath:
          file.path,

        fileName:
          file.name,

        folder,

        title:
          source.title,

        heading:
          chunk.heading,

        sectionNumber:
          chunk.sectionNumber,

        sectionTitle:
          chunk.sectionTitle,

        content:
          chunk.content,

        tags:
          source.tags,

        links:
          source.links,

        properties:
          source.properties,

        pageStart:
          chunk.pageStart,

        pageEnd:
          chunk.pageEnd,

        mtime:
          file.stat.mtime,

        embedding:
          chunk.embedding,
      };

      await this
        .knowledgeIndex
        .add(
          vaultChunk,
        );

      chunkIds.push(id);
    }

    this.manifest
      .documents[
      file.path
    ] = {
      hash:
        fileHash,

      mtime:
        file.stat.mtime,

      chunkIds,

      sourceType:
        source.sourceType,

      fileName:
        file.name,

      title:
        source.title,

      pageCount:
        source.pageCount,
    };
  }

  private async removeDocument(
    path: string,
  ): Promise<void> {
    await this
      .commitSemaphore
      .run(
        async () => {
          if (!this.manifest) {
            return;
          }

          const existing =
            this.manifest
              .documents[
              path
            ];

          if (!existing) {
            return;
          }

          await this
            .knowledgeIndex
            .removeMany(
              existing.chunkIds,
            );

          delete this.manifest
            .documents[
            path
          ];
        },
      );

    this.schedulePersist();
    this.refreshStatusCounts();
  }

  private schedulePersist():
    void {
    if (
      this.persistTimer !==
      null
    ) {
      window.clearTimeout(
        this.persistTimer,
      );
    }

    this.persistTimer =
      window.setTimeout(
        () => {
          this.persistTimer =
            null;

          void this
            .persistNow()
            .catch(
              (error) => {
                this.setStatus(
                  "error",
                  `Could not save the index: ${this.errorText(error)}`,
                );
              },
            );
        },
        PERSIST_DEBOUNCE_MS,
      );
  }

  private async persistNow():
    Promise<void> {
    if (!this.manifest) {
      return;
    }

    if (
      this.persistInFlight
    ) {
      await this
        .persistInFlight;

      return;
    }

    this.persistInFlight =
      this.commitSemaphore
        .run(
          async () => {
            if (!this.manifest) {
              return;
            }

            await this.fileSystem
              .run(
                "saving knowledge index",
                "knowledge-index.json",
                async () =>
                  this.knowledgeIndex
                    .save(),
              );

            await this.fileSystem
              .run(
                "saving index manifest",
                this.manifestPath,
                async () =>
                  saveManifest(
                    this.app.vault
                      .adapter,
                    this.manifestPath,
                    this.manifest!,
                  ),
              );
          },
        );

    try {
      await this
        .persistInFlight;
    } finally {
      this.persistInFlight =
        null;
    }

    this.refreshStatusCounts();
  }

  private embeddingText(
    file: TFile,
    source:
      SourceInfo,
    chunk:
      PreparedChunk,
  ): string {
    const lines = [
      `Document: ${source.title}`,
      `File: ${file.name}`,
      `Path: ${file.path}`,
      `Source type: ${source.sourceType}`,
      `Heading: ${chunk.heading}`,
    ];

    if (
      chunk.sectionNumber
    ) {
      lines.push(
        `Section number: ${chunk.sectionNumber}`,
      );

      if (
        chunk.sectionTitle
      ) {
        lines.push(
          `Section title: ${chunk.sectionTitle}`,
        );
      }
    }

    if (
      source.sourceType ===
        "pdf" &&
      chunk.pageStart > 0
    ) {
      lines.push(
        chunk.pageStart ===
          chunk.pageEnd
          ? `PDF page: ${chunk.pageStart}`
          : `PDF pages: ${chunk.pageStart}-${chunk.pageEnd}`,
      );
    }

    if (
      source.tags.length >
      0
    ) {
      lines.push(
        `Tags: ${source.tags.join(", ")}`,
      );
    }

    if (
      source.properties
        .length > 0
    ) {
      lines.push(
        `Properties: ${source.properties.join(", ")}`,
      );
    }

    lines.push(
      "",
      chunk.content,
    );

    return lines.join(
      "\n",
    );
  }

  private sourceConcurrency():
    number {
    return this.clampInteger(
      this.settings
        .indexingConcurrency,
      MIN_SOURCE_CONCURRENCY,
      MAX_SOURCE_CONCURRENCY,
      3,
    );
  }

  private filesystemConcurrency():
    number {
    return this.clampInteger(
      this.settings
        .filesystemConcurrency,
      MIN_FILESYSTEM_CONCURRENCY,
      MAX_FILESYSTEM_CONCURRENCY,
      2,
    );
  }

  private pdfPageConcurrency():
    number {
    return this.clampInteger(
      this.settings
        .pdfPageConcurrency,
      MIN_PDF_PAGE_CONCURRENCY,
      MAX_PDF_PAGE_CONCURRENCY,
      6,
    );
  }

  private embeddingBatchSize():
    number {
    return this.clampInteger(
      this.settings
        .embeddingBatchSize,
      MIN_EMBEDDING_BATCH_SIZE,
      MAX_EMBEDDING_BATCH_SIZE,
      32,
    );
  }

  private embeddingConcurrency():
    number {
    if (
      this.embeddings
        .usesLocalEmbeddings()
    ) {
      return 1;
    }

    return this.clampInteger(
      this.settings
        .embeddingConcurrency,
      MIN_EMBEDDING_CONCURRENCY,
      MAX_EMBEDDING_CONCURRENCY,
      2,
    );
  }

  private clampInteger(
    value: number,
    minimum: number,
    maximum: number,
    fallback: number,
  ): number {
    if (
      !Number.isFinite(value)
    ) {
      return fallback;
    }

    return Math.max(
      minimum,
      Math.min(
        maximum,
        Math.floor(value),
      ),
    );
  }

  private updateRebuildStatus(
    progress:
      RebuildProgress,
  ): void {
    const activeNames =
      Array.from(
        progress
          .activeSources,
      )
        .slice(0, 3)
        .map(
          (path) =>
            this.shortSourceName(
              path,
            ),
        );

    const activeSuffix =
      activeNames.length > 0
        ? ` · Active: ${activeNames.join(" | ")}`
        : "";

    const knownChunkText =
      progress.knownChunks > 0
        ? `${progress.embeddedChunks}/${progress.knownChunks} known chunks embedded`
        : "waiting for chunks";

    const pdfPageText =
      progress.knownPdfPages > 0
        ? `${progress.completedPdfPages}/${progress.knownPdfPages} known PDF pages extracted`
        : "waiting for PDF pages";

    this.setStatus(
      "indexing",
      `Indexing ${progress.completedSources}/${progress.totalSources} sources` +
        ` · ${progress.activeSources.size} source worker(s) active` +
        ` · ${this.fileSystem.getActiveCount()} filesystem op(s) active` +
        ` · ${progress.activePdfPages} PDF page(s) active` +
        ` · ${progress.activeEmbeddingRequests} embedding job(s) active` +
        ` · ${pdfPageText}` +
        ` · ${knownChunkText}` +
        activeSuffix,
    );
  }

  private shortSourceName(
    path: string,
  ): string {
    const parts =
      path.split("/");

    const name =
      parts[
        parts.length - 1
      ] ?? path;

    if (
      name.length <= 34
    ) {
      return name;
    }

    return (
      `${name.slice(0, 31)}...`
    );
  }

  private chunkId(
    filePath: string,
    chunkIndex: number,
  ): string {
    return (
      `${filePath}::` +
      `${chunkIndex}`
    );
  }

  private isIndexableFile(
    file: TAbstractFile,
  ): file is TFile {
    if (
      this.isMarkdownFile(
        file,
      )
    ) {
      return true;
    }

    if (
      !this.settings
        .indexPdfSources
    ) {
      return false;
    }

    return this.isPdfFile(
      file,
    );
  }

  private isMarkdownFile(
    file: TAbstractFile,
  ): file is TFile {
    return (
      file instanceof
        TFile &&
      file.extension
        .toLowerCase() ===
        "md"
    );
  }

  private isPdfFile(
    file: TAbstractFile,
  ): file is TFile {
    return (
      file instanceof
        TFile &&
      file.extension
        .toLowerCase() ===
        "pdf"
    );
  }

  private manifestPdfSetting():
    boolean {
    /*
     * Old version-7 manifests have no source-policy
     * field because PDF indexing was unconditional.
     * Treat missing as true.
     */
    return this.manifest
      ?.indexPdfSources ??
      true;
  }

  private setStatus(
    state:
      IndexStatus[
        "state"
      ],
    message: string,
  ): void {
    const counts =
      this.counts();

    this.status = {
      state,
      message,

      documentCount:
        counts.documents,

      chunkCount:
        counts.chunks,

      lastIndexedAt:
        this.manifest
          ?.lastIndexedAt ??
        null,
    };

    this.emitStatus();
  }

  private refreshStatusCounts():
    void {
    const counts =
      this.counts();

    this.status = {
      ...this.status,

      documentCount:
        counts.documents,

      chunkCount:
        counts.chunks,

      lastIndexedAt:
        this.manifest
          ?.lastIndexedAt ??
        null,
    };

    this.emitStatus();
  }

  private counts(): {
    documents: number;
    chunks: number;
  } {
    if (!this.manifest) {
      return {
        documents: 0,
        chunks: 0,
      };
    }

    const documents =
      Object.values(
        this.manifest
          .documents,
      );

    return {
      documents:
        documents.length,

      chunks:
        documents.reduce(
          (
            total,
            document,
          ) =>
            total +
            document
              .chunkIds
              .length,
          0,
        ),
    };
  }

  private emitStatus():
    void {
    const snapshot =
      this.getStatus();

    for (
      const listener of
      this.listeners
    ) {
      listener(
        snapshot,
      );
    }
  }

  private errorText(
    error: unknown,
  ): string {
    if (
      error instanceof
      Error
    ) {
      return error.message;
    }

    return String(error);
  }
}
