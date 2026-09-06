export interface LocalVaultAISettings {
  ollamaUrl: string;

  chatModel: string;
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

  chatModel: "qwen3:8b",

  lectureModel: "qwen3:30b-instruct",

  embeddingModel: "embeddinggemma",

  autoIndex: true,

  topK: 8,

  hybridTextWeight: 0.45,
  hybridVectorWeight: 0.55,

  minVectorSimilarity: 0.35,

  vaultOnly: true,

  modifyDebounceMs: 1400,
};
