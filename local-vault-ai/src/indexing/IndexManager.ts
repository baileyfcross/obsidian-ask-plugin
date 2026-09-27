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
import {
  IndexFailureStore,
} from "./IndexFailureStore";
import {
  PortableIndexStore,
} from "./PortableIndexStore";

export interface RetryFailedIndexResult {
  status:
    | "success"
    | "failed"
    | "busy"
    | "missing"
    | "not-indexable";

  message: string;
}

const PERSIST_DEBOUNCE_MS =
  2200;

/*
 * Full rebuilds can run for a long time. Save a durable recovery
 * snapshot periodically so a reload/crash does not throw away the
 * entire run. The checkpoint is intentionally coarse because saving
 * the full Orama index is expensive.
 */
const REBUILD_CHECKPOINT_SOURCE_INTERVAL =
  2000;

const REBUILD_CHECKPOINT_MAX_AGE_MS =
  20 * 60 * 1000;

/*
 * Rebuild progress used to update the chat UI on virtually every page
 * and embedding batch. Throttle those DOM-facing updates so indexing
 * cannot flood Obsidian's renderer.
 */
const REBUILD_STATUS_MIN_INTERVAL_MS =
  1000;

/*
 * Insert committed chunks in bounded batches. This is much faster when a
 * portable source cache restores thousands of existing chunks, while the
 * yield between batches still gives Electron regular paint opportunities.
 */
const COMMIT_INSERT_BATCH_SIZE =
  64;

const NO_SECTION_KEY =
  "__none__";

const MIN_SOURCE_CONCURRENCY =
  1;

const MAX_SOURCE_CONCURRENCY =
  8;

/*
 * Local ONNX embeddings execute on the same Electron renderer that draws
 * Obsidian. Once local embeddings are the bottleneck, extra source/PDF
 * workers mostly increase memory pressure and UI contention rather than
 * throughput. Keep only enough parallelism to overlap one source preparing
 * with another source embedding.
 */
const LOCAL_SOURCE_CONCURRENCY_CAP =
  2;

const MIN_FILESYSTEM_CONCURRENCY =
  1;

const MAX_FILESYSTEM_CONCURRENCY =
  4;

const MIN_PDF_PAGE_CONCURRENCY =
  1;

const MAX_PDF_PAGE_CONCURRENCY =
  16;

const LOCAL_PDF_PAGE_CONCURRENCY_CAP =
  1;

const MIN_EMBEDDING_BATCH_SIZE =
  4;

const MAX_EMBEDDING_BATCH_SIZE =
  128;

const LOCAL_EMBEDDING_BATCH_SIZE_CAP =
  8;

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

  /*
   * When present, the expensive extract/chunk/embed stages were skipped and
   * these already-embedded chunks came from the portable content-addressed
   * source cache.
   */
  cachedVaultChunks?:
    VaultChunk[];

  reusedFromPortable?:
    boolean;
}

interface RebuildCheckpointState {
  version: 1;
  indexVersion: number;
  embeddingProvider: string;
  embeddingIdentity: string;
  embeddingDimensions: number;
  indexPdfSources: boolean;
  startedAt: number;
  lastCheckpointAt: number;
  completedSources: number;
  totalSources: number;
  snapshotSaved: boolean;
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

  failedSources:
    number;

  reusedSources:
    number;

  reusedChunks:
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

  private readonly indexFailureStore:
    IndexFailureStore;

  private readonly portableIndex:
    PortableIndexStore;

  private readonly manifestPath:
    string;

  private readonly rebuildCheckpointPath:
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
   * Prevent the same failed source from being retried twice at the same
   * time from the Failed indexes modal. A retry still uses the normal
   * single-file indexing path so persistence, portable-cache updates, and
   * failure clearing behave exactly like any other incremental update.
   */
  private readonly retryingFailedPaths =
    new Set<string>();

  /*
   * Orama mutations and persistence remain
   * serialized even when preparation/embedding
   * happens concurrently.
   */
  private readonly commitSemaphore =
    new AsyncSemaphore(1);

  /*
   * Keep PDF reads bounded, but do not serialize every PDF behind one
   * reader. Two concurrent binary reads gives the source workers enough
   * overlap to avoid the severe PDF slowdown from the previous patch
   * while still preventing all filesystem workers from reading large
   * PDFs at once. FileSystemGate remains the outer I/O safety limit.
   */
  private readonly pdfReadSemaphore =
    new AsyncSemaphore(2);

  /*
   * When Obsidian is minimized or unfocused, keep large PDF reads
   * serialized. Foreground indexing still uses the normal two-reader
   * limit above.
   */
  private readonly backgroundPdfReadSemaphore =
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

  private rebuildCheckpointInFlight:
    Promise<void> | null =
    null;

  private lastRebuildCheckpointCompleted =
    0;

  private lastRebuildCheckpointAt =
    0;

  private lastRebuildStatusUpdateAt =
    0;

  private activeRebuildProgress:
    RebuildProgress | null =
    null;

  private activeRebuildStartedAt:
    number | null =
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
    indexFailureStore:
      IndexFailureStore,
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

    const manifestSlash =
      manifestPath.lastIndexOf(
        "/",
      );

    const manifestDirectory =
      manifestSlash >= 0
        ? manifestPath.slice(
            0,
            manifestSlash + 1,
          )
        : "";

    const dataDirectory =
      manifestSlash >= 0
        ? manifestPath.slice(
            0,
            manifestSlash,
          )
        : "";

    this.portableIndex =
      new PortableIndexStore(
        this.app.vault.adapter,
        dataDirectory,
      );

    this.rebuildCheckpointPath =
      `${manifestDirectory}index-rebuild-state.json`;

    this.indexFailureStore =
      indexFailureStore;

    this.fileSystem =
      new FileSystemGate(
        this.filesystemConcurrency(),
      );
  }

  async initialize():
    Promise<void> {
    try {
      await this.portableIndex
        .initialize();

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
          this.portableIndex
            .hasManifest()
            ? "The runtime knowledge index is not present. Rebuild the index to restore compatible sources from the portable index cache without re-embedding them."
            : "No knowledge index exists yet. Rebuild the index.",
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
          this.portableIndex
            .hasManifest()
            ? "The runtime search index is missing. Rebuild the index to reconstruct it from compatible portable source objects without re-running PDF extraction or embeddings."
            : "The index manifest exists, but the search index is missing. Rebuild the index.",
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

      try {
        await this.portableIndex
          .prepareProfile(
            activeEmbedding,
            this.manifest
              .embeddingDimensions,
            INDEX_VERSION,
            this.manifestPdfSetting(),
          );

        await this
          .migrateCurrentIndexToPortableCache(
            activeEmbedding,
            this.manifest
              .embeddingDimensions,
          );
      } catch (error) {
        /*
         * The runtime index remains usable even if the optional portable
         * cache could not be migrated. A later persist/rebuild will retry.
         */
        console.warn(
          "[Local Vault AI] Could not finish portable-index migration.",
          error,
        );
      }

      const interruptedRebuild =
        await this.loadRebuildCheckpoint();

      if (interruptedRebuild) {
        const savedText =
          interruptedRebuild.snapshotSaved
            ? `${interruptedRebuild.completedSources}/${interruptedRebuild.totalSources} source(s) are preserved in the latest checkpoint.`
            : "No durable source checkpoint had been written yet.";

        this.setStatus(
          "needs-rebuild",
          `An interrupted knowledge-index rebuild was detected. ${savedText} Run Rebuild index to resume from the saved checkpoint when possible.`,
        );

        return;
      }

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

      await this.indexFailureStore
        .pruneMissingSources();

      await this.portableIndex
        .initialize();

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

      await this.portableIndex
        .prepareProfile(
          embeddingDescriptor,
          dimensions,
          INDEX_VERSION,
          this.settings
            .indexPdfSources,
        );

      await this
        .migrateCurrentIndexToPortableCache(
          embeddingDescriptor,
          dimensions,
        );

      const previousCheckpoint =
        await this.loadRebuildCheckpoint();

      const canResume =
        this.canResumeRebuild(
          previousCheckpoint,
          embeddingDescriptor,
          dimensions,
        );

      const rebuildStartedAt =
        canResume &&
        previousCheckpoint
          ? previousCheckpoint.startedAt
          : Date.now();

      if (!canResume) {
        await this.clearRebuildCheckpoint();

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
      }

      const allFiles =
        this.app.vault
          .getFiles()
          .filter(
            (file) =>
              this.isIndexableFile(
                file,
              ),
          );

      this.portableIndex
        .retainSources(
          new Set(
            allFiles.map(
              (file) =>
                file.path,
            ),
          ),
        );

      const files =
        canResume
          ? allFiles.filter(
              (file) =>
                !this.isSourceSavedInCheckpoint(
                  file,
                ),
            )
          : allFiles;

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

      const resumedCounts =
        canResume
          ? this.rebuildResumeCounts(
              allFiles,
            )
          : {
              sources: 0,
              chunks: 0,
              pdfPages: 0,
              markdown: 0,
              pdf: 0,
            };

      const progress:
        RebuildProgress = {
        totalSources:
          allFiles.length,

        completedSources:
          resumedCounts.sources,

        activeSources:
          new Set<string>(),

        activePdfPages:
          0,

        completedPdfPages:
          resumedCounts.pdfPages,

        knownPdfPages:
          resumedCounts.pdfPages,

        activeEmbeddingRequests:
          0,

        knownChunks:
          resumedCounts.chunks,

        embeddedChunks:
          resumedCounts.chunks,

        markdownCompleted:
          resumedCounts.markdown,

        pdfCompleted:
          resumedCounts.pdf,

        skippedPdfs:
          0,

        failedSources:
          0,

        reusedSources:
          0,

        reusedChunks:
          0,
      };

      this.activeRebuildProgress =
        progress;
      this.activeRebuildStartedAt =
        rebuildStartedAt;

      this.lastRebuildCheckpointCompleted =
        progress.completedSources;
      this.lastRebuildCheckpointAt =
        previousCheckpoint?.lastCheckpointAt ??
        rebuildStartedAt;

      if (!canResume) {
        await this.saveRebuildCheckpoint({
          version: 1,
          indexVersion:
            INDEX_VERSION,
          embeddingProvider:
            embeddingDescriptor.provider,
          embeddingIdentity:
            embeddingDescriptor.identity,
          embeddingDimensions:
            dimensions,
          indexPdfSources:
            this.settings.indexPdfSources,
          startedAt:
            rebuildStartedAt,
          lastCheckpointAt:
            rebuildStartedAt,
          completedSources: 0,
          totalSources:
            allFiles.length,
          snapshotSaved:
            false,
        });
      }

      this.updateRebuildStatus(
        progress,
        true,
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
            const committedChunks =
              await this
                .commitSemaphore
                .run(
                  async () =>
                    this
                      .commitPreparedDocument(
                        prepared,
                      ),
                );

            await this
              .cachePreparedDocument(
                prepared,
                committedChunks,
              );

            await this
              .indexFailureStore
              .clear(
                file.path,
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

              await this
                .recordIndexFailure(
                  file,
                  error,
                );

              console.warn(
                `[Local Vault AI] ${error.message}`,
              );

              return;
            }

            if (
              error instanceof
              FileSystemOperationError
            ) {
              progress
                .failedSources +=
                1;

              await this
                .recordIndexFailure(
                  file,
                  error,
                );

              console.warn(
                `[Local Vault AI] Skipping failed source ${file.path}: ${error.message}`,
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

            try {
              await this.maybeCheckpointRebuild(
                progress,
                rebuildStartedAt,
                embeddingDescriptor,
                dimensions,
              );
            } catch (checkpointError) {
              console.warn(
                "[Local Vault AI] Could not save an intermediate rebuild checkpoint.",
                checkpointError,
              );
            }
          }
        },
      );

      if (
        this.rebuildCheckpointInFlight
      ) {
        await this.rebuildCheckpointInFlight;
      }

      this.setTransientStatus(
        "indexing",
        `Saving final knowledge index · ${progress.completedSources}/${progress.totalSources} sources processed...`,
      );

      const finalSaveStartedAt =
        Date.now();

      await this.saveRebuildCheckpoint({
        version: 1,
        indexVersion:
          INDEX_VERSION,
        embeddingProvider:
          embeddingDescriptor.provider,
        embeddingIdentity:
          embeddingDescriptor.identity,
        embeddingDimensions:
          dimensions,
        indexPdfSources:
          this.settings.indexPdfSources,
        startedAt:
          rebuildStartedAt,
        lastCheckpointAt:
          finalSaveStartedAt,
        completedSources:
          progress.completedSources,
        totalSources:
          progress.totalSources,
        snapshotSaved:
          false,
      });

      await this.yieldToUi();
      await this.persistNow();
      await this.clearRebuildCheckpoint();

      const skippedText =
        progress.skippedPdfs >
        0
          ? ` Skipped ${progress.skippedPdfs} PDF(s) with no extractable text.`
          : "";

      const failedText =
        progress.failedSources >
        0
          ? ` Skipped ${progress.failedSources} source(s) that failed to index. Open Failed indexes in the chat toolbar for details.`
          : "";

      const reusedText =
        progress.reusedSources >
        0
          ? ` Reused ${progress.reusedSources} source(s) / ${progress.reusedChunks} chunk(s) from the portable cache without PDF extraction or embedding.`
          : "";

      this.setStatus(
        "ready",
        this.settings
          .indexPdfSources
          ? (
              `Indexed ${progress.markdownCompleted} Markdown file(s) and ` +
              `${progress.pdfCompleted} PDF file(s).${skippedText}${failedText}${reusedText}`
            )
          : (
              `Indexed ${progress.markdownCompleted} Markdown file(s). ` +
              "PDF/source indexing is disabled; this is a Markdown-only knowledge index." +
              failedText +
              reusedText
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
      this.activeRebuildProgress =
        null;
      this.activeRebuildStartedAt =
        null;

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
    void this
      .indexFailureStore
      .clear(
        oldPath,
      );

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
    void this
      .indexFailureStore
      .clear(
        file.path,
      );

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

      const committedChunks =
        await this
          .commitSemaphore
          .run(
            async () =>
              this
                .commitPreparedDocument(
                  prepared,
                ),
          );

      await this
        .cachePreparedDocument(
          prepared,
          committedChunks,
        );

      await this
        .indexFailureStore
        .clear(
          file.path,
        );

      this.schedulePersist();
      this.refreshStatusCounts();
    } catch (error) {
      if (
        error instanceof
        FileSystemOperationError
      ) {
        await this
          .recordIndexFailure(
            file,
            error,
          );

        console.warn(
          `[Local Vault AI] Skipping failed source ${file.path}: ${error.message}`,
        );

        this.setStatus(
          "ready",
          `Skipped ${file.path} after indexing failed. Open Failed indexes in the chat toolbar for details.`,
        );

        return;
      }

      if (
        error instanceof
        PdfNoTextError
      ) {
        await this
          .recordIndexFailure(
            file,
            error,
          );

        console.warn(
          `[Local Vault AI] ${error.message}`,
        );

        this.setStatus(
          "ready",
          `${error.message} Open Failed indexes in the chat toolbar for details.`,
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

  async retryFailedIndex(
    path: string,
  ): Promise<RetryFailedIndexResult> {
    if (
      this.retryingFailedPaths
        .size > 0
    ) {
      return {
        status: "busy",
        message:
          this.retryingFailedPaths
            .has(path)
            ? `${path} is already being retried.`
            : "Another failed source is already being retried. Wait for it to finish before starting another retry.",
      };
    }

    if (
      this.status.state !==
      "ready"
    ) {
      return {
        status: "busy",
        message:
          this.status.state ===
          "indexing"
            ? "Wait for the current index operation to finish before retrying a failed source."
            : `The index is currently ${this.status.state}. ${this.status.message}`,
      };
    }

    const source =
      this.app.vault
        .getAbstractFileByPath(
          path,
        );

    if (
      !(source instanceof TFile)
    ) {
      /*
       * The source was deleted or moved after the failure was recorded.
       * It can no longer be retried, so remove the stale failure record.
       */
      await this.indexFailureStore
        .clear(path);

      return {
        status: "missing",
        message:
          `${path} no longer exists in the vault, so its stale failure record was removed.`,
      };
    }

    if (
      !this.isIndexableFile(
        source,
      )
    ) {
      return {
        status: "not-indexable",
        message:
          `${path} is not currently eligible for indexing with the active source settings.`,
      };
    }

    this.retryingFailedPaths
      .add(path);

    try {
      await this.indexFile(
        source,
      );

      if (
        !this.indexFailureStore
          .has(path)
      ) {
        return {
          status: "success",
          message:
            `${path} indexed successfully.`,
        };
      }

      return {
        status: "failed",
        message:
          `${path} failed again and remains in Failed indexes.`,
      };
    } catch (error) {
      /*
       * indexFile normally isolates per-source failures itself. Keep this
       * guard so an unexpected retry-only exception cannot escape the modal
       * event handler or interrupt the rest of the plugin.
       */
      return {
        status: "failed",
        message:
          `Retry failed for ${path}: ${this.errorText(error)}`,
      };
    } finally {
      this.retryingFailedPaths
        .delete(path);
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
      if (
        this.activeRebuildProgress &&
        this.activeRebuildStartedAt !==
          null
      ) {
        const descriptor =
          this.embeddings
            .getDescriptor();

        const flushStartedAt =
          Date.now();

        await this.saveRebuildCheckpoint({
          version: 1,
          indexVersion:
            INDEX_VERSION,
          embeddingProvider:
            descriptor.provider,
          embeddingIdentity:
            descriptor.identity,
          embeddingDimensions:
            this.manifest.embeddingDimensions,
          indexPdfSources:
            this.settings.indexPdfSources,
          startedAt:
            this.activeRebuildStartedAt,
          lastCheckpointAt:
            flushStartedAt,
          completedSources:
            this.activeRebuildProgress.completedSources,
          totalSources:
            this.activeRebuildProgress.totalSources,
          snapshotSaved:
            false,
        });

        await this.persistNow();

        await this.saveRebuildCheckpoint({
          version: 1,
          indexVersion:
            INDEX_VERSION,
          embeddingProvider:
            descriptor.provider,
          embeddingIdentity:
            descriptor.identity,
          embeddingDimensions:
            this.manifest.embeddingDimensions,
          indexPdfSources:
            this.settings.indexPdfSources,
          startedAt:
            this.activeRebuildStartedAt,
          lastCheckpointAt:
            Date.now(),
          completedSources:
            this.counts().documents,
          totalSources:
            this.activeRebuildProgress.totalSources,
          snapshotSaved:
            true,
        });
      } else {
        await this.persistNow();
      }
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

  private async migrateCurrentIndexToPortableCache(
    embeddingDescriptor: {
      provider: string;
      identity: string;
    },
    dimensions: number,
  ): Promise<void> {
    if (
      !this.manifest ||
      !this.knowledgeIndex
        .isReady()
    ) {
      return;
    }

    if (
      this.manifest.version !==
        INDEX_VERSION ||
      this.manifest
        .embeddingProvider !==
        embeddingDescriptor.provider ||
      this.manifest
        .embeddingIdentity !==
        embeddingDescriptor.identity ||
      this.manifest
        .embeddingDimensions !==
        dimensions ||
      this.manifestPdfSetting() !==
        this.settings
          .indexPdfSources
    ) {
      return;
    }

    const missing =
      Object.entries(
        this.manifest
          .documents,
      ).filter(
        ([
          sourcePath,
          document,
        ]) =>
          !this.portableIndex
            .hasSource(
              sourcePath,
              document.hash,
            ),
      );

    if (missing.length === 0) {
      return;
    }

    this.setTransientStatus(
      "indexing",
      `Preparing portable source cache · 0/${missing.length} source(s)...`,
    );

    let completed = 0;

    for (
      const [
        sourcePath,
        document,
      ] of missing
    ) {
      const chunks =
        await this
          .knowledgeIndex
          .getMany(
            document.chunkIds,
          );

      if (
        chunks.length !==
        document.chunkIds
          .length
      ) {
        console.warn(
          `[Local Vault AI] Could not migrate ${sourcePath} into the portable cache because ${document.chunkIds.length - chunks.length} runtime chunk(s) were missing.`,
        );

        continue;
      }

      await this.portableIndex
        .putSource(
          sourcePath,
          document.hash,
          document.sourceType,
          document.fileName,
          document.title,
          document.pageCount,
          chunks,
        );

      completed += 1;

      if (
        completed % 10 ===
          0 ||
        completed ===
          missing.length
      ) {
        this.setTransientStatus(
          "indexing",
          `Preparing portable source cache · ${completed}/${missing.length} source(s)...`,
        );

        await this.yieldToUi();
      }
    }

    await this.portableIndex
      .save();
  }

  private async tryPreparePortableDocument(
    file: TFile,
    fileHash: string,
    progress:
      RebuildProgress | null,
  ): Promise<
    PreparedDocument | null
  > {
    const cached =
      await this.portableIndex
        .loadSource(
          file.path,
          fileHash,
        );

    if (!cached) {
      return null;
    }

    const expectedSourceType:
      SourceType =
      this.isPdfFile(file)
        ? "pdf"
        : "markdown";

    if (
      cached.sourceType !==
      expectedSourceType
    ) {
      return null;
    }

    const cachedVaultChunks:
      VaultChunk[] =
      cached.chunks.map(
        (chunk) => ({
          ...chunk,
          mtime:
            file.stat.mtime,
        }),
      );

    const firstChunk =
      cachedVaultChunks[0];

    const source:
      SourceInfo = {
      sourceType:
        cached.sourceType,
      title:
        cached.title,
      tags:
        firstChunk?.tags ??
        [],
      links:
        firstChunk?.links ??
        [],
      properties:
        firstChunk
          ?.properties ??
        [],
      pageCount:
        cached.pageCount,
    };

    if (progress) {
      progress.knownChunks +=
        cachedVaultChunks.length;

      progress.embeddedChunks +=
        cachedVaultChunks.length;

      progress.reusedSources +=
        1;

      progress.reusedChunks +=
        cachedVaultChunks.length;

      if (
        cached.sourceType ===
          "pdf" &&
        cached.pageCount
      ) {
        progress.knownPdfPages +=
          cached.pageCount;

        progress.completedPdfPages +=
          cached.pageCount;
      }

      this.updateRebuildStatus(
        progress,
      );
    }

    return {
      file,
      fileHash,
      source,
      chunks: [],
      cachedVaultChunks,
      reusedFromPortable:
        true,
    };
  }

  private async cachePreparedDocument(
    prepared:
      PreparedDocument,
    chunks: VaultChunk[],
  ): Promise<void> {
    if (
      prepared
        .reusedFromPortable
    ) {
      return;
    }

    try {
      await this.portableIndex
        .putSource(
          prepared.file.path,
          prepared.fileHash,
          prepared.source
            .sourceType,
          prepared.file.name,
          prepared.source.title,
          prepared.source
            .pageCount,
          chunks,
        );
    } catch (error) {
      /*
       * Search/index correctness wins over cache portability. The next
       * persist or startup migration can retry exporting this source.
       */
      console.warn(
        `[Local Vault AI] Could not save portable source cache for ${prepared.file.path}.`,
        error,
      );
    }
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

    const cached =
      await this
        .tryPreparePortableDocument(
          file,
          fileHash,
          progress,
        );

    if (cached) {
      return cached;
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

    const readPdfBuffer =
      async (): Promise<ArrayBuffer> =>
        this.pdfReadSemaphore
          .run(
            async () =>
              this.fileSystem
                .run(
                  "reading PDF source",
                  file.path,
                  async () =>
                    this.app.vault
                      .readBinary(file),
                ),
          );

    const buffer =
      this.isRendererBackgrounded()
        ? await this
            .backgroundPdfReadSemaphore
            .run(
              readPdfBuffer,
            )
        : await readPdfBuffer();

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

    const cached =
      await this
        .tryPreparePortableDocument(
          file,
          fileHash,
          progress,
        );

    if (cached) {
      return cached;
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
           * The caller has already hashed the PDF and does not need the
           * byte array again. Let PDF.js own this buffer instead of
           * duplicating it, which substantially reduces renderer memory
           * pressure while multiple PDFs are active.
           */
          copyInput:
            false,

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

                    /*
                     * Give Electron a real event-loop turn before and
                     * after a potentially expensive local ONNX batch.
                     * This prevents a chain of source workers from
                     * starving the renderer/compositor.
                     */
                    await this.yieldToUi();

                    const embeddings =
                      await this.embeddings
                        .embed(
                          inputs,
                        );

                    await this.yieldToUi();

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
  ): Promise<VaultChunk[]> {
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
      cachedVaultChunks,
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

    let vaultChunks:
      VaultChunk[];

    if (cachedVaultChunks) {
      /*
       * mtime is intentionally excluded from portable objects so the same
       * cached chunks remain byte-identical after a Git clone. Rehydrate
       * only that machine-specific field when rebuilding the runtime index.
       */
      vaultChunks =
        cachedVaultChunks
          .map(
            (chunk) => ({
              ...chunk,
              mtime:
                file.stat.mtime,
            }),
          );
    } else {
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

      const folder =
        file.parent?.path ===
        "/"
          ? ""
          : file.parent
              ?.path ??
            "";

      vaultChunks =
        chunks.map(
          (chunk): VaultChunk => {
            const id =
              this.chunkId(
                file.path,
                chunk.index,
              );

            return {
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
          },
        );
    }

    /*
     * Chunk ids are the primary key in Orama. A malformed/stale portable
     * source should never make one source fail the entire rebuild just
     * because the same id appears twice in the prepared payload. Keep the
     * last copy for that logical chunk and make the manifest match exactly
     * what is inserted into the runtime index.
     */
    if (
      vaultChunks.length > 1
    ) {
      const uniqueById =
        new Map<
          string,
          VaultChunk
        >();

      for (const chunk of vaultChunks) {
        uniqueById.set(
          chunk.id,
          chunk,
        );
      }

      if (
        uniqueById.size !==
        vaultChunks.length
      ) {
        console.warn(
          `[Local Vault AI] Removed ${vaultChunks.length - uniqueById.size} duplicate chunk id(s) while rebuilding ${file.path}.`,
        );

        vaultChunks =
          [...uniqueById.values()];
      }
    }

    for (
      let offset = 0;
      offset <
      vaultChunks.length;
      offset +=
      COMMIT_INSERT_BATCH_SIZE
    ) {
      await this
        .knowledgeIndex
        .addMany(
          vaultChunks.slice(
            offset,
            offset +
              COMMIT_INSERT_BATCH_SIZE,
          ),
        );

      await this.yieldToUi();
    }

    const chunkIds =
      vaultChunks.map(
        (chunk) =>
          chunk.id,
      );

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

    return vaultChunks;
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

          this.portableIndex
            .removeSource(
              path,
            );

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

            /*
             * Persist the portable source map first. If the larger Orama
             * runtime snapshot fails later, already-indexed source objects
             * are still durable and can be reused on the next rebuild.
             */
            await this.portableIndex
              .save();

            await this.yieldToUi();

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

  private async maybeCheckpointRebuild(
    progress: RebuildProgress,
    rebuildStartedAt: number,
    embeddingDescriptor: {
      provider: string;
      identity: string;
    },
    dimensions: number,
  ): Promise<void> {
    if (
      this.rebuildCheckpointInFlight
    ) {
      return;
    }

    const now =
      Date.now();

    const sourcesSinceCheckpoint =
      progress.completedSources -
      this.lastRebuildCheckpointCompleted;

    const checkpointDueByCount =
      sourcesSinceCheckpoint >=
      REBUILD_CHECKPOINT_SOURCE_INTERVAL;

    const checkpointDueByTime =
      sourcesSinceCheckpoint > 0 &&
      now -
        this.lastRebuildCheckpointAt >=
        REBUILD_CHECKPOINT_MAX_AGE_MS;

    if (
      !checkpointDueByCount &&
      !checkpointDueByTime
    ) {
      return;
    }

    const checkpointPromise =
      (async () => {
        this.setTransientStatus(
          "indexing",
          `Saving rebuild checkpoint · ${progress.completedSources}/${progress.totalSources} sources processed...`,
        );

        const checkpointAttemptAt =
          Date.now();

        /*
         * Mark the recovery snapshot unsafe before replacing either half of
         * the runtime snapshot. If Obsidian closes after the Orama snapshot
         * is written but before index-manifest.json is written, the next
         * rebuild will reconstruct from the portable cache instead of
         * resuming a mixed-generation index/manifest pair.
         */
        await this.saveRebuildCheckpoint({
          version: 1,
          indexVersion:
            INDEX_VERSION,
          embeddingProvider:
            embeddingDescriptor.provider,
          embeddingIdentity:
            embeddingDescriptor.identity,
          embeddingDimensions:
            dimensions,
          indexPdfSources:
            this.settings.indexPdfSources,
          startedAt:
            rebuildStartedAt,
          lastCheckpointAt:
            checkpointAttemptAt,
          completedSources:
            progress.completedSources,
          totalSources:
            progress.totalSources,
          snapshotSaved:
            false,
        });

        await this.yieldToUi();
        await this.persistNow();

        const checkpointAt =
          Date.now();

        await this.saveRebuildCheckpoint({
          version: 1,
          indexVersion:
            INDEX_VERSION,
          embeddingProvider:
            embeddingDescriptor.provider,
          embeddingIdentity:
            embeddingDescriptor.identity,
          embeddingDimensions:
            dimensions,
          indexPdfSources:
            this.settings.indexPdfSources,
          startedAt:
            rebuildStartedAt,
          lastCheckpointAt:
            checkpointAt,
          completedSources:
            this.counts().documents,
          totalSources:
            progress.totalSources,
          snapshotSaved:
            true,
        });

        this.lastRebuildCheckpointCompleted =
          progress.completedSources;
        this.lastRebuildCheckpointAt =
          checkpointAt;

        this.updateRebuildStatus(
          progress,
          true,
        );
      })();

    this.rebuildCheckpointInFlight =
      checkpointPromise;

    try {
      await checkpointPromise;
    } finally {
      if (
        this.rebuildCheckpointInFlight ===
        checkpointPromise
      ) {
        this.rebuildCheckpointInFlight =
          null;
      }
    }
  }

  private canResumeRebuild(
    checkpoint:
      RebuildCheckpointState | null,
    embeddingDescriptor: {
      provider: string;
      identity: string;
    },
    dimensions: number,
  ): boolean {
    if (
      !checkpoint ||
      !checkpoint.snapshotSaved ||
      !this.manifest ||
      !this.knowledgeIndex.isReady()
    ) {
      return false;
    }

    return (
      checkpoint.indexVersion ===
        INDEX_VERSION &&
      checkpoint.embeddingProvider ===
        embeddingDescriptor.provider &&
      checkpoint.embeddingIdentity ===
        embeddingDescriptor.identity &&
      checkpoint.embeddingDimensions ===
        dimensions &&
      checkpoint.indexPdfSources ===
        this.settings.indexPdfSources &&
      this.manifest.version ===
        INDEX_VERSION &&
      this.manifest.embeddingProvider ===
        embeddingDescriptor.provider &&
      this.manifest.embeddingIdentity ===
        embeddingDescriptor.identity &&
      this.manifest.embeddingDimensions ===
        dimensions &&
      this.manifestPdfSetting() ===
        this.settings.indexPdfSources
    );
  }

  private isSourceSavedInCheckpoint(
    file: TFile,
  ): boolean {
    if (!this.manifest) {
      return false;
    }

    const existing =
      this.manifest.documents[
        file.path
      ];

    if (!existing) {
      return false;
    }

    const sourceType:
      SourceType =
      file.extension
        .toLowerCase() ===
      "pdf"
        ? "pdf"
        : "markdown";

    return (
      existing.mtime ===
        file.stat.mtime &&
      existing.sourceType ===
        sourceType
    );
  }

  private rebuildResumeCounts(
    allFiles: TFile[],
  ): {
    sources: number;
    chunks: number;
    pdfPages: number;
    markdown: number;
    pdf: number;
  } {
    if (!this.manifest) {
      return {
        sources: 0,
        chunks: 0,
        pdfPages: 0,
        markdown: 0,
        pdf: 0,
      };
    }

    let sources = 0;
    let chunks = 0;
    let pdfPages = 0;
    let markdown = 0;
    let pdf = 0;

    for (const file of allFiles) {
      if (
        !this.isSourceSavedInCheckpoint(
          file,
        )
      ) {
        continue;
      }

      const document =
        this.manifest.documents[
          file.path
        ];

      if (!document) {
        continue;
      }

      sources += 1;
      chunks +=
        document.chunkIds.length;

      if (
        document.sourceType ===
        "pdf"
      ) {
        pdf += 1;
        pdfPages +=
          document.pageCount ??
          0;
      } else {
        markdown += 1;
      }
    }

    return {
      sources,
      chunks,
      pdfPages,
      markdown,
      pdf,
    };
  }

  private async loadRebuildCheckpoint():
    Promise<
      RebuildCheckpointState | null
    > {
    try {
      const exists =
        await this.app.vault.adapter.exists(
          this.rebuildCheckpointPath,
        );

      if (!exists) {
        return null;
      }

      const raw =
        await this.app.vault.adapter.read(
          this.rebuildCheckpointPath,
        );

      const parsed =
        JSON.parse(
          raw,
        ) as
          Partial<RebuildCheckpointState>;

      if (
        parsed.version !== 1 ||
        typeof parsed.indexVersion !==
          "number" ||
        typeof parsed.embeddingProvider !==
          "string" ||
        typeof parsed.embeddingIdentity !==
          "string" ||
        typeof parsed.embeddingDimensions !==
          "number" ||
        typeof parsed.indexPdfSources !==
          "boolean" ||
        typeof parsed.startedAt !==
          "number" ||
        typeof parsed.lastCheckpointAt !==
          "number" ||
        typeof parsed.completedSources !==
          "number" ||
        typeof parsed.totalSources !==
          "number" ||
        typeof parsed.snapshotSaved !==
          "boolean"
      ) {
        return null;
      }

      return parsed as
        RebuildCheckpointState;
    } catch (error) {
      console.warn(
        "[Local Vault AI] Could not read rebuild checkpoint state.",
        error,
      );

      return null;
    }
  }

  private async saveRebuildCheckpoint(
    state:
      RebuildCheckpointState,
  ): Promise<void> {
    await this.app.vault.adapter.write(
      this.rebuildCheckpointPath,
      JSON.stringify(
        state,
        null,
        2,
      ),
    );
  }

  private async clearRebuildCheckpoint():
    Promise<void> {
    try {
      if (
        await this.app.vault.adapter.exists(
          this.rebuildCheckpointPath,
        )
      ) {
        await this.app.vault.adapter.remove(
          this.rebuildCheckpointPath,
        );
      }
    } catch (error) {
      console.warn(
        "[Local Vault AI] Could not clear rebuild checkpoint state.",
        error,
      );
    }
  }

  private isRendererBackgrounded():
    boolean {
    const htmlDocument =
      globalThis.document;

    if (!htmlDocument) {
      return false;
    }

    return (
      htmlDocument.visibilityState !==
        "visible" ||
      !htmlDocument.hasFocus()
    );
  }

  /*
   * Use MessageChannel instead of relying only on setTimeout(0).
   * Chromium aggressively throttles timers for minimized/background
   * windows, while a posted message still gives the event loop a real
   * task boundary. That allows Electron to process compositor/window
   * work between indexing batches.
   */
  private async yieldToUi():
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
        window.setTimeout(
          resolve,
          0,
        );
      },
    );
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

  private async recordIndexFailure(
    file: TFile,
    error: unknown,
  ): Promise<void> {
    const message =
      this.errorText(
        error,
      );

    await this
      .indexFailureStore
      .record({
        path:
          file.path,

        extension:
          file.extension,

        message,

        attempts:
          this.indexFailureAttempts(
            message,
          ),
      });
  }

  private indexFailureAttempts(
    message: string,
  ): number {
    const match =
      message.match(
        /\(attempt\s+(\d+)\s+of\s+(\d+)\)/i,
      );

    if (!match) {
      return 1;
    }

    const attempts =
      Number.parseInt(
        match[2] ?? "1",
        10,
      );

    if (
      !Number.isFinite(
        attempts,
      )
    ) {
      return 1;
    }

    return Math.max(
      1,
      attempts,
    );
  }

  private sourceConcurrency():
    number {
    const configured =
      this.clampInteger(
        this.settings
          .indexingConcurrency,
        MIN_SOURCE_CONCURRENCY,
        MAX_SOURCE_CONCURRENCY,
        3,
      );

    if (
      this.embeddings
        .usesLocalEmbeddings()
    ) {
      return Math.min(
        configured,
        LOCAL_SOURCE_CONCURRENCY_CAP,
      );
    }

    return configured;
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
    const configured =
      this.clampInteger(
        this.settings
          .pdfPageConcurrency,
        MIN_PDF_PAGE_CONCURRENCY,
        MAX_PDF_PAGE_CONCURRENCY,
        6,
      );

    if (
      this.embeddings
        .usesLocalEmbeddings()
    ) {
      return Math.min(
        configured,
        LOCAL_PDF_PAGE_CONCURRENCY_CAP,
      );
    }

    return configured;
  }

  private embeddingBatchSize():
    number {
    const configured =
      this.clampInteger(
        this.settings
          .embeddingBatchSize,
        MIN_EMBEDDING_BATCH_SIZE,
        MAX_EMBEDDING_BATCH_SIZE,
        32,
      );

    if (
      this.embeddings
        .usesLocalEmbeddings()
    ) {
      return Math.min(
        configured,
        LOCAL_EMBEDDING_BATCH_SIZE_CAP,
      );
    }

    return configured;
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
    force = false,
  ): void {
    const now =
      Date.now();

    /*
     * Do not keep driving chat-toolbar DOM updates while Electron is
     * minimized/unfocused. The in-memory counters continue advancing and
     * the next foreground update is emitted immediately.
     */
    if (
      !force &&
      this.isRendererBackgrounded()
    ) {
      return;
    }

    if (
      !force &&
      now -
        this.lastRebuildStatusUpdateAt <
        REBUILD_STATUS_MIN_INTERVAL_MS
    ) {
      return;
    }

    this.lastRebuildStatusUpdateAt =
      now;

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

    const reusedText =
      progress.reusedSources >
        0
        ? ` · ${progress.reusedSources} source(s) reused from portable cache`
        : "";

    this.setTransientStatus(
      "indexing",
      `Indexing ${progress.completedSources}/${progress.totalSources} sources` +
        ` · ${progress.activeSources.size} source worker(s) active` +
        ` · ${this.fileSystem.getActiveCount()} filesystem op(s) active` +
        ` · ${progress.activePdfPages} PDF page(s) active` +
        ` · ${progress.activeEmbeddingRequests} embedding job(s) active` +
        ` · ${pdfPageText}` +
        ` · ${knownChunkText}` +
        reusedText +
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

  /*
   * Rebuild progress is emitted frequently. Do not rescan the entire
   * manifest/chunk list for every progress message; with thousands of
   * documents and tens of thousands of chunks that O(n) recount was a
   * major source of renderer lag. Durable saves and final status updates
   * still refresh the exact counts.
   */
  private setTransientStatus(
    state:
      IndexStatus[
        "state"
      ],
    message: string,
  ): void {
    this.status = {
      ...this.status,
      state,
      message,
      lastIndexedAt:
        this.manifest
          ?.lastIndexedAt ??
        this.status
          .lastIndexedAt,
    };

    this.emitStatus();
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
