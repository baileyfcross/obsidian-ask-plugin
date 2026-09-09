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

const EMBEDDING_BATCH_SIZE = 24;
const PERSIST_DEBOUNCE_MS = 2200;
const NO_SECTION_KEY =
  "__none__";

interface PreparedChunk {
  heading: string;
  sectionNumber: string;
  sectionTitle: string;
  content: string;
  index: number;
  pageStart: number;
  pageEnd: number;
}

interface SourceInfo {
  sourceType: SourceType;
  title: string;
  tags: string[];
  links: string[];
  properties: string[];
  pageCount?: number;
}

export class IndexManager {
  private readonly app:
    App;

  private readonly settings:
    LocalVaultAISettings;

  private readonly ollama:
    OllamaClient;

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

  private persistTimer:
    number | null = null;

  private persistInFlight:
    Promise<void> | null =
    null;

  /*
   * Constructor form used by the original PDF patch.
   */
  constructor(
    app: App,
    settings:
      LocalVaultAISettings,
    ollama:
      OllamaClient,
    knowledgeIndex:
      KnowledgeIndex,
    manifestPath:
      string,
  );

  /*
   * Constructor form used when the safe model-runtime
   * lease has also been wired into indexing.
   */
  constructor(
    app: App,
    settings:
      LocalVaultAISettings,
    ollama:
      OllamaClient,
    modelRuntime:
      ModelRuntimeManager,
    knowledgeIndex:
      KnowledgeIndex,
    manifestPath:
      string,
  );

  constructor(
    app: App,
    settings:
      LocalVaultAISettings,
    ollama:
      OllamaClient,
    fourth:
      | KnowledgeIndex
      | ModelRuntimeManager,
    fifth:
      | KnowledgeIndex
      | string,
    sixth?:
      string,
  ) {
    this.app = app;
    this.settings =
      settings;
    this.ollama =
      ollama;

    if (
      typeof sixth ===
      "string"
    ) {
      this.modelRuntime =
        fourth as
          ModelRuntimeManager;

      this.knowledgeIndex =
        fifth as
          KnowledgeIndex;

      this.manifestPath =
        sixth;
    } else {
      this.modelRuntime =
        null;

      this.knowledgeIndex =
        fourth as
          KnowledgeIndex;

      this.manifestPath =
        fifth as string;
    }
  }

  async initialize():
    Promise<void> {
    try {
      this.manifest =
        await loadManifest(
          this.app.vault
            .adapter,
          this.manifestPath,
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
          "The index format changed to add exact PDF section metadata and source-name resolution. Rebuild the index.",
        );

        return;
      }

      if (
        this.manifest
          .embeddingModel !==
        this.settings
          .embeddingModel
      ) {
        this.setStatus(
          "needs-rebuild",
          `The index uses "${this.manifest.embeddingModel}" but settings use ` +
            `"${this.settings.embeddingModel}". Rebuild the index.`,
        );

        return;
      }

      if (
        !(await this
          .knowledgeIndex
          .existsOnDisk())
      ) {
        this.setStatus(
          "needs-rebuild",
          "The index manifest exists, but the search index is missing. Rebuild the index.",
        );

        return;
      }

      await this
        .knowledgeIndex
        .load(
          this.manifest
            .embeddingDimensions,
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

    if (
      this.manifest &&
      this.manifest
        .embeddingModel !==
        this.settings
          .embeddingModel
    ) {
      this.setStatus(
        "needs-rebuild",
        `Embedding model changed to "${this.settings.embeddingModel}". Rebuild the index.`,
      );
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
      if (
        this.modelRuntime
      ) {
        lease =
          this.modelRuntime
            .acquireJob({
              kind:
                "index-rebuild",

              label:
                "Rebuilding knowledge index",

              models: [
                this.settings
                  .embeddingModel,
              ],
            });
      }

      this.setStatus(
        "indexing",
        "Checking Ollama...",
      );

      await this
        .validateOllamaForIndexing();

      const dimensions =
        await this.ollama
          .embeddingDimension(
            this.settings
              .embeddingModel,
          );

      await this
        .knowledgeIndex
        .createEmpty(
          dimensions,
        );

      this.manifest =
        createEmptyManifest(
          this.settings
            .embeddingModel,
          dimensions,
        );

      const files =
        this.app.vault
          .getFiles()
          .filter(
            (file) =>
              this.isIndexableFile(
                file,
              ),
          );

      let markdownCount = 0;
      let pdfCount = 0;
      let skippedPdfCount = 0;

      for (
        let fileIndex = 0;
        fileIndex <
        files.length;
        fileIndex += 1
      ) {
        const file =
          files[
            fileIndex
          ];

        if (!file) {
          continue;
        }

        this.setStatus(
          "indexing",
          `Indexing ${fileIndex + 1} of ${files.length}: ${file.path}`,
        );

        try {
          await this
            .indexFileInternal(
              file,
              true,
            );

          if (
            this.isPdfFile(
              file,
            )
          ) {
            pdfCount += 1;
          } else {
            markdownCount +=
              1;
          }
        } catch (error) {
          if (
            error instanceof
            PdfNoTextError
          ) {
            skippedPdfCount +=
              1;

            console.warn(
              `[Local Vault AI] ${error.message}`,
            );

            continue;
          }

          throw error;
        }
      }

      await this.persistNow();

      const skippedText =
        skippedPdfCount > 0
          ? ` Skipped ${skippedPdfCount} PDF(s) with no extractable text.`
          : "";

      this.setStatus(
        "ready",
        `Indexed ${markdownCount} Markdown file(s) and ${pdfCount} PDF file(s).${skippedText}`,
      );
    } catch (error) {
      if (
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
      timer !== undefined
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
      if (
        this.modelRuntime
      ) {
        lease =
          this.modelRuntime
            .acquireJob({
              kind:
                "index-update",

              label:
                `Indexing ${file.path}`,

              models: [
                this.settings
                  .embeddingModel,
              ],
            });
      }

      await this
        .validateOllamaForIndexing();

      await this
        .indexFileInternal(
          file,
          false,
        );

      this.schedulePersist();
      this.refreshStatusCounts();
    } catch (error) {
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

  private async indexFileInternal(
    file: TFile,
    force: boolean,
  ): Promise<void> {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const extension =
      file.extension
        .toLowerCase();

    if (extension === "md") {
      await this
        .indexMarkdownFile(
          file,
          force,
        );

      return;
    }

    if (extension === "pdf") {
      await this
        .indexPdfFile(
          file,
          force,
        );

      return;
    }

    throw new Error(
      `Unsupported index source: ${file.path}`,
    );
  }

  private async indexMarkdownFile(
    file: TFile,
    force: boolean,
  ): Promise<void> {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const markdown =
      await this.app.vault
        .cachedRead(file);

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
      return;
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

    await this
      .replaceDocumentChunks(
        file,
        fileHash,
        chunks,
        {
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
        },
      );
  }

  private async indexPdfFile(
    file: TFile,
    force: boolean,
  ): Promise<void> {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

    const buffer =
      await this.app.vault
        .readBinary(file);

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
      return;
    }

    /*
     * Extract before removing the previous version.
     * If a modified PDF becomes unreadable, the last
     * good indexed copy remains available.
     */
    const extracted =
      await extractPdf(
        bytes,
        file.name,
      );

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

    await this
      .replaceDocumentChunks(
        file,
        fileHash,
        chunks,
        {
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
        },
      );
  }

  private async replaceDocumentChunks(
    file: TFile,
    fileHash: string,
    chunks:
      PreparedChunk[],
    source:
      SourceInfo,
  ): Promise<void> {
    if (!this.manifest) {
      throw new Error(
        "Index manifest is not initialized.",
      );
    }

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
      let offset = 0;
      offset <
      chunks.length;
      offset +=
      EMBEDDING_BATCH_SIZE
    ) {
      const batch =
        chunks.slice(
          offset,
          offset +
          EMBEDDING_BATCH_SIZE,
        );

      const inputs =
        batch.map(
          (chunk) =>
            this.embeddingText(
              file,
              source,
              chunk,
            ),
        );

      const embeddings =
        await this.ollama
          .embed(
            this.settings
              .embeddingModel,
            inputs,
          );

      if (
        embeddings.length !==
        batch.length
      ) {
        throw new Error(
          `Embedding count mismatch for ${file.path}.`,
        );
      }

      for (
        let batchIndex = 0;
        batchIndex <
        batch.length;
        batchIndex += 1
      ) {
        const chunk =
          batch[
            batchIndex
          ];

        const embedding =
          embeddings[
            batchIndex
          ];

        if (
          !chunk ||
          !embedding
        ) {
          continue;
        }

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

            embedding,
          };

        await this
          .knowledgeIndex
          .add(
            vaultChunk,
          );

        chunkIds.push(id);
      }
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
    }

    this.persistInFlight =
      (async () => {
        await this
          .knowledgeIndex
          .save();

        await saveManifest(
          this.app.vault
            .adapter,
          this.manifestPath,
          this.manifest as
            IndexManifest,
        );
      })();

    try {
      await this
        .persistInFlight;
    } finally {
      this.persistInFlight =
        null;
    }

    this.refreshStatusCounts();
  }

  private async validateOllamaForIndexing():
    Promise<void> {
    this.ollama.setBaseUrl(
      this.settings
        .ollamaUrl,
    );

    const available =
      await this.ollama
        .isAvailable();

    if (!available) {
      throw new Error(
        `Ollama is offline. Could not connect to ${this.settings.ollamaUrl}. ` +
          "Start Ollama and try again.",
      );
    }

    const exists =
      await this.ollama
        .modelExists(
          this.settings
            .embeddingModel,
        );

    if (!exists) {
      throw new Error(
        `Embedding model "${this.settings.embeddingModel}" is not installed in Ollama. ` +
          `Run: ollama pull ${this.settings.embeddingModel}`,
      );
    }
  }

  private embeddingText(
    file: TFile,
    source: SourceInfo,
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
    return (
      this.isMarkdownFile(
        file,
      ) ||
      this.isPdfFile(
        file,
      )
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
