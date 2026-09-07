export type ChatReasoningEffort =
  | "low"
  | "medium"
  | "high";

export interface LocalVaultAISettings {
  ollamaUrl: string;

  chatModel: string;
  chatReasoningEffort: ChatReasoningEffort;
  chatKeepAlive: string;
  showModelReasoning: boolean;

  lectureModel: string;
  embeddingModel: string;

  autoIndex: boolean;

  topK: number;
  hybridTextWeight: number;
  hybridVectorWeight: number;
  minVectorSimilarity: number;

  vaultOnly: boolean;

  modifyDebounceMs: number;
}

export const DEFAULT_SETTINGS: LocalVaultAISettings = {
  ollamaUrl: "http://localhost:11434",

  // General knowledge / vault explorer.
  chatModel: "gpt-oss:20b",

  // GPT-OSS cannot fully disable thinking in Ollama.
  // "low" is the best default for ordinary vault chat.
  chatReasoningEffort: "low",

  // Keep the general chat model resident for a short period
  // so repeated questions do not repeatedly pay model-load cost.
  chatKeepAlive: "10m",

  // Shows the model-provided reasoning trace in a collapsed
  // panel above assistant answers. This does not change
  // reasoning effort; it only controls UI visibility.
  showModelReasoning: true,

  // Dedicated lecture / slide-generation model.
  lectureModel: "qwen3:30b-instruct",

  // Indexing and retrieval model.
  embeddingModel: "embeddinggemma",

  autoIndex: true,

  topK: 8,
  hybridTextWeight: 0.45,
  hybridVectorWeight: 0.55,
  minVectorSimilarity: 0.35,

  vaultOnly: true,

  modifyDebounceMs: 1400,
};
