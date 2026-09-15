export type ChatReasoningEffort =
  | "low"
  | "medium"
  | "high";

export interface LocalVaultAISettings {
  ollamaUrl: string;

  chatModel: string;
  chatReasoningEffort:
    ChatReasoningEffort;
  chatKeepAlive: string;
  showModelReasoning: boolean;

  lectureModel: string;

  /*
   * GENERATION RUNTIME OPTIONS.
   *
   * These are sent in the per-request Ollama "options"
   * object for chat and lecture generation.
   *
   * generationCpuThreads:
   *   0 = allow Ollama/llama.cpp to choose automatically.
   *   A positive value explicitly sets num_thread.
   *
   * generationBatchSize:
   *   Prompt-evaluation batch size (num_batch).
   *
   * chatContextSize:
   *   Context window used for normal vault chat.
   *
   * lectureContextSize:
   *   Context window used for lecture/slide generation.
   */
  generationCpuThreads: number;
  generationBatchSize: number;
  chatContextSize: number;
  lectureContextSize: number;

  /*
   * EMBEDDINGS ONLY.
   *
   * true:
   *   document/query embeddings run locally through
   *   the direct ONNX embedding backend.
   *
   * false:
   *   document/query embeddings use embeddingModel
   *   through the configured Ollama server.
   *
   * This setting never changes where chat, reasoning,
   * lecture generation, or other generative model
   * requests run. Those always use ollamaUrl.
   */
  useLocalEmbeddings: boolean;

  /*
   * Ollama embedding model used only when
   * useLocalEmbeddings is false.
   */
  embeddingModel: string;

  autoIndex: boolean;

  /*
   * When true, PDF/source-material files are indexed
   * alongside Markdown.
   *
   * When false, the knowledge index contains Markdown
   * files only.
   *
   * Changing this setting requires an index rebuild so
   * stale PDF chunks cannot remain searchable.
   */
  indexPdfSources: boolean;

  /*
   * Full-rebuild parallelism.
   *
   * indexingConcurrency:
   *   Number of source files that may be prepared at
   *   the same time.
   *
   * filesystemConcurrency:
   *   Maximum number of actual vault/plugin filesystem
   *   reads or writes allowed at the same time.
   *
   * pdfPageConcurrency:
   *   Maximum number of PDF pages being text-extracted
   *   across all active PDFs.
   *
   * embeddingBatchSize:
   *   Number of chunks sent through one embedding batch.
   *
   * embeddingConcurrency:
   *   Maximum concurrent Ollama /api/embed requests.
   *   This is ignored/disabled while local embeddings
   *   are active because the local ONNX backend uses one
   *   shared batched inference pipeline.
   */
  indexingConcurrency: number;
  filesystemConcurrency: number;
  pdfPageConcurrency: number;
  embeddingBatchSize: number;
  embeddingConcurrency: number;

  topK: number;
  hybridTextWeight: number;
  hybridVectorWeight: number;
  minVectorSimilarity: number;

  vaultOnly: boolean;

  modifyDebounceMs: number;
}

export const DEFAULT_SETTINGS:
  LocalVaultAISettings = {
  ollamaUrl:
    "http://localhost:11434",

  // General knowledge / vault explorer.
  chatModel:
    "gpt-oss:20b",

  // GPT-OSS supports low / medium / high.
  chatReasoningEffort:
    "low",

  chatKeepAlive:
    "10m",

  showModelReasoning:
    true,

  // Dedicated lecture / slide-generation model.
  lectureModel:
    "qwen3:30b-instruct",

  /*
   * Generation runtime defaults.
   *
   * Four threads matches a four-physical-core CPU well
   * and is a conservative starting point. The settings
   * UI also exposes 6 and 8 for benchmarking SMT usage.
   *
   * 8K context keeps memory use substantially lower than
   * very large model-default context windows.
   */
  generationCpuThreads:
    4,

  generationBatchSize:
    256,

  chatContextSize:
    8192,

  lectureContextSize:
    8192,

  /*
   * Local embeddings are the default.
   *
   * Only embeddings run locally. All generative model
   * requests continue to use the configured Ollama
   * server.
   */
  useLocalEmbeddings:
    true,

  /*
   * Preserved while local embeddings are enabled so a
   * user can switch back to remote Ollama embeddings
   * without re-entering the model name.
   */
  embeddingModel:
    "embeddinggemma",

  autoIndex:
    true,

  /*
   * Preserve the historical Local Vault AI behavior:
   * Markdown and PDF files are indexed by default.
   *
   * Disable this in Settings -> Indexing to create a
   * Markdown-only knowledge index.
   */
  indexPdfSources:
    true,

  /*
   * Three source workers allow extraction/chunking CPU
   * work to overlap without loading the whole vault at
   * once.
   */
  indexingConcurrency:
    3,

  /*
   * Actual filesystem access is deliberately more
   * conservative than source preparation.
   *
   * If filesystem timeouts persist, lower this to 1.
   */
  filesystemConcurrency:
    2,

  /*
   * Global PDF page extraction limit. Even with several
   * active PDFs, only six pages total may be inside
   * PDF.js text extraction at once.
   */
  pdfPageConcurrency:
    6,

  /*
   * Conservative local/remote embedding batch size.
   */
  embeddingBatchSize:
    32,

  /*
   * Used only for remote Ollama embeddings.
   * Local ONNX mode uses one shared batched pipeline.
   */
  embeddingConcurrency:
    2,

  topK:
    8,

  hybridTextWeight:
    0.45,

  hybridVectorWeight:
    0.55,

  minVectorSimilarity:
    0.35,

  vaultOnly:
    true,

  modifyDebounceMs:
    1400,
};
