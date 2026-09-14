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
