import {
  App,
  TAbstractFile,
  TFile,
} from "obsidian";
import { LocalVaultAISettings } from "../settings/Settings";
import { OllamaClient } from "../ollama/OllamaClient";
import { KnowledgeIndex } from "../search/KnowledgeIndex";
import {
  IndexStatus,
  VaultChunk,
} from "../types";
import { chunkMarkdown } from "./Chunker";
import { extractMetadata } from "./MetadataExtractor";
import { sha256 } from "./Hash";
import {
  createEmptyManifest,
  INDEX_VERSION,
  IndexManifest,
  loadManifest,
  saveManifest,
} from "./IndexManifest";

const EMBEDDING_BATCH_SIZE = 24;
const PERSIST_DEBOUNCE_MS = 2200;

export class IndexManager {
  private manifest: IndexManifest | null = null;

  private status: IndexStatus = {
    state: "uninitialized",
    message: "Index has not been initialized.",
    documentCount: 0,
    chunkCount: 0,
    lastIndexedAt: null,
  };

  private readonly listeners = new Set<
    (status: IndexStatus) => void
  >();

  private readonly fileTimers = new Map<
    string,
    number
  >();

  private persistTimer: number | null = null;
  private persistInFlight: Promise<void> | null =
    null;

  constructor(
    private readonly app: App,
    private readonly settings: LocalVaultAISettings,
    private readonly ollama: OllamaClient,
    private readonly knowledgeIndex: KnowledgeIndex,
    private readonly manifestPath: string,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.manifest = await loadManifest(
        this.app.vault.adapter,
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
        this.manifest.version !== INDEX_VERSION
      ) {
        this.setStatus(
          "needs-rebuild",
          "The index format changed. Rebuild the index.",
        );
        return;
      }

      if (
        this.manifest.embeddingModel !==
        this.settings.embeddingModel
      ) {
        this.setStatus(
          "needs-rebuild",
          `The index uses "${this.manifest.embeddingModel}" but settings use ` +
            `"${this.settings.embeddingModel}". Rebuild the index.`,
        );
        return;
      }

      if (
        !(await this.knowledgeIndex.existsOnDisk())
      ) {
        this.setStatus(
          "needs-rebuild",
          "The index manifest exists, but the search index is missing. Rebuild the index.",
        );
        return;
      }

      await this.knowledgeIndex.load(
        this.manifest.embeddingDimensions,
      );

      this.setStatus(
        "ready",
        "Knowledge index is ready.",
      );
    } catch (error) {
      this.setStatus(
        "error",
        this.errorText(error),
      );
    }
  }

  getStatus(): IndexStatus {
    return {
      ...this.status,
    };
  }

  subscribe(
    listener: (status: IndexStatus) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());

    return () => {
      this.listeners.delete(listener);
    };
  }

  async onSettingsChanged(): Promise<void> {
    this.ollama.setBaseUrl(
      this.settings.ollamaUrl,
    );

    if (
      this.manifest &&
      this.manifest.embeddingModel !==
        this.settings.embeddingModel
    ) {
      this.setStatus(
        "needs-rebuild",
        `Embedding model changed to "${this.settings.embeddingModel}". Rebuild the index.`,
      );
    }
  }

  async rebuildAll(): Promise<void> {
    if (this.status.state === "indexing") {
      throw new Error(
        "An index operation is already running.",
      );
    }

    this.setStatus(
      "indexing",
      "Checking Ollama...",
    );

    try {
      await this.validateOllamaForIndexing();

      const dimensions =
        await this.ollama.embeddingDimension(
          this.settings.embeddingModel,
        );

      await this.knowledgeIndex.createEmpty(
        dimensions,
      );

      this.manifest = createEmptyManifest(
        this.settings.embeddingModel,
        dimensions,
      );

      const files =
        this.app.vault.getMarkdownFiles();

      for (
        let fileIndex = 0;
        fileIndex < files.length;
        fileIndex += 1
      ) {
        const file = files[fileIndex];

        if (!file) {
          continue;
        }

        this.setStatus(
          "indexing",
          `Indexing ${fileIndex + 1} of ${files.length}: ${file.path}`,
        );

        await this.indexFileInternal(
          file,
          true,
        );
      }

      await this.persistNow();

      this.setStatus(
        "ready",
        `Indexed ${files.length} Markdown files.`,
      );
    } catch (error) {
      this.setStatus(
        "error",
        this.errorText(error),
      );
      throw error;
    }
  }

  handleCreate(file: TAbstractFile): void {
    if (!this.isMarkdownFile(file)) {
      return;
    }

    this.scheduleFile(file);
  }

  handleModify(file: TAbstractFile): void {
    if (!this.isMarkdownFile(file)) {
      return;
    }

    this.scheduleFile(file);
  }

  handleRename(
    file: TAbstractFile,
    oldPath: string,
  ): void {
    if (!this.settings.autoIndex) {
      return;
    }

    if (this.status.state !== "ready") {
      return;
    }

    const oldTimer =
      this.fileTimers.get(oldPath);

    if (oldTimer !== undefined) {
      window.clearTimeout(oldTimer);
      this.fileTimers.delete(oldPath);
    }

    void this.removeDocument(oldPath).then(
      async () => {
        if (this.isMarkdownFile(file)) {
          await this.indexFile(file);
        }
      },
    );
  }

  handleDelete(file: TAbstractFile): void {
    if (!this.settings.autoIndex) {
      return;
    }

    if (!this.isMarkdownFile(file)) {
      return;
    }

    if (this.status.state !== "ready") {
      return;
    }

    const timer =
      this.fileTimers.get(file.path);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.fileTimers.delete(file.path);
    }

    void this.removeDocument(file.path);
  }

  async indexFile(
    file: TFile,
  ): Promise<void> {
    if (this.status.state !== "ready") {
      return;
    }

    try {
      await this.validateOllamaForIndexing();
      await this.indexFileInternal(file, false);
      this.schedulePersist();
      this.refreshStatusCounts();
    } catch (error) {
      this.setStatus(
        "error",
        `Could not index ${file.path}: ${this.errorText(error)}`,
      );
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (
      this.manifest &&
      this.knowledgeIndex.isReady()
    ) {
      await this.persistNow();
    }
  }

  dispose(): void {
    for (const timer of this.fileTimers.values()) {
      window.clearTimeout(timer);
    }

    this.fileTimers.clear();

    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.listeners.clear();
  }

  private scheduleFile(file: TFile): void {
    if (!this.settings.autoIndex) {
      return;
    }

    if (this.status.state !== "ready") {
      return;
    }

    const current =
      this.fileTimers.get(file.path);

    if (current !== undefined) {
      window.clearTimeout(current);
    }

    const timer = window.setTimeout(() => {
      this.fileTimers.delete(file.path);
      void this.indexFile(file);
    }, this.settings.modifyDebounceMs);

    this.fileTimers.set(file.path, timer);
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

    const markdown =
      await this.app.vault.cachedRead(file);

    const fileHash = await sha256(markdown);
    const existing =
      this.manifest.documents[file.path];

    if (!force && existing?.hash === fileHash) {
      return;
    }

    if (existing) {
      await this.knowledgeIndex.removeMany(
        existing.chunkIds,
      );
    }

    const metadata = extractMetadata(
      this.app,
      file,
    );

    const markdownChunks =
      chunkMarkdown(markdown);

    const chunkIds: string[] = [];

    for (
      let offset = 0;
      offset < markdownChunks.length;
      offset += EMBEDDING_BATCH_SIZE
    ) {
      const batch = markdownChunks.slice(
        offset,
        offset + EMBEDDING_BATCH_SIZE,
      );

      const inputs = batch.map((chunk) =>
        this.embeddingText(
          file,
          chunk.heading,
          chunk.content,
          metadata.tags,
          metadata.properties,
        ),
      );

      const embeddings =
        await this.ollama.embed(
          this.settings.embeddingModel,
          inputs,
        );

      if (embeddings.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch for ${file.path}.`,
        );
      }

      for (
        let batchIndex = 0;
        batchIndex < batch.length;
        batchIndex += 1
      ) {
        const chunk = batch[batchIndex];
        const embedding =
          embeddings[batchIndex];

        if (!chunk || !embedding) {
          continue;
        }

        const id =
          this.chunkId(
            file.path,
            chunk.index,
          );

        const folder =
          file.parent?.path === "/"
            ? ""
            : file.parent?.path ?? "";

        const vaultChunk: VaultChunk = {
          id,
          filePath: file.path,
          fileName: file.name,
          folder,
          title: file.basename,
          heading: chunk.heading,
          content: chunk.content,
          tags: metadata.tags,
          links: metadata.links,
          properties: metadata.properties,
          mtime: file.stat.mtime,
          embedding,
        };

        await this.knowledgeIndex.add(
          vaultChunk,
        );

        chunkIds.push(id);
      }
    }

    this.manifest.documents[file.path] = {
      hash: fileHash,
      mtime: file.stat.mtime,
      chunkIds,
    };
  }

  private async removeDocument(
    path: string,
  ): Promise<void> {
    if (!this.manifest) {
      return;
    }

    const existing =
      this.manifest.documents[path];

    if (!existing) {
      return;
    }

    await this.knowledgeIndex.removeMany(
      existing.chunkIds,
    );

    delete this.manifest.documents[path];

    this.schedulePersist();
    this.refreshStatusCounts();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
    }

    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow().catch((error) => {
        this.setStatus(
          "error",
          `Could not save the index: ${this.errorText(error)}`,
        );
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow(): Promise<void> {
    if (!this.manifest) {
      return;
    }

    if (this.persistInFlight) {
      await this.persistInFlight;
    }

    this.persistInFlight = (async () => {
      await this.knowledgeIndex.save();
      await saveManifest(
        this.app.vault.adapter,
        this.manifestPath,
        this.manifest as IndexManifest,
      );
    })();

    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = null;
    }

    this.refreshStatusCounts();
  }

  private async validateOllamaForIndexing(): Promise<void> {
    this.ollama.setBaseUrl(
      this.settings.ollamaUrl,
    );

    const available =
      await this.ollama.isAvailable();

    if (!available) {
      throw new Error(
        `Ollama is offline. Could not connect to ${this.settings.ollamaUrl}. ` +
          "Start Ollama and try again.",
      );
    }

    const exists =
      await this.ollama.modelExists(
        this.settings.embeddingModel,
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
    heading: string,
    content: string,
    tags: string[],
    properties: string[],
  ): string {
    const lines = [
      `Document: ${file.basename}`,
      `Path: ${file.path}`,
      `Section: ${heading}`,
    ];

    if (tags.length > 0) {
      lines.push(`Tags: ${tags.join(", ")}`);
    }

    if (properties.length > 0) {
      lines.push(
        `Properties: ${properties.join(", ")}`,
      );
    }

    lines.push("", content);

    return lines.join("\n");
  }

  private chunkId(
    filePath: string,
    chunkIndex: number,
  ): string {
    return `${filePath}::${chunkIndex}`;
  }

  private isMarkdownFile(
    file: TAbstractFile,
  ): file is TFile {
    return (
      file instanceof TFile &&
      file.extension.toLowerCase() === "md"
    );
  }

  private setStatus(
    state: IndexStatus["state"],
    message: string,
  ): void {
    const counts = this.counts();

    this.status = {
      state,
      message,
      documentCount: counts.documents,
      chunkCount: counts.chunks,
      lastIndexedAt:
        this.manifest?.lastIndexedAt ?? null,
    };

    this.emitStatus();
  }

  private refreshStatusCounts(): void {
    const counts = this.counts();

    this.status = {
      ...this.status,
      documentCount: counts.documents,
      chunkCount: counts.chunks,
      lastIndexedAt:
        this.manifest?.lastIndexedAt ?? null,
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

    const documents = Object.values(
      this.manifest.documents,
    );

    return {
      documents: documents.length,
      chunks: documents.reduce(
        (total, document) =>
          total + document.chunkIds.length,
        0,
      ),
    };
  }

  private emitStatus(): void {
    const snapshot = this.getStatus();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
