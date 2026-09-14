import type {
  LocalVaultAISettings,
} from "../settings/Settings";

/*
 * This abstraction is intentionally EMBEDDING-ONLY.
 *
 * It must never be used for chat, lecture generation,
 * reasoning, summarization, or any other generative job.
 * Those jobs continue to use OllamaClient directly and
 * therefore always go to settings.ollamaUrl.
 */
export type EmbeddingProvider =
  | "local"
  | "ollama";

export interface EmbeddingDescriptor {
  provider:
    EmbeddingProvider;

  identity: string;
  displayName: string;
}

export interface EmbeddingService {
  getDescriptor():
    EmbeddingDescriptor;

  validate():
    Promise<void>;

  embeddingDimension():
    Promise<number>;

  embed(
    input: string[],
  ): Promise<number[][]>;
}

/*
 * Direct local embedding stack.
 *
 * The local backend intentionally avoids the larger
 * Transformers.js package. Local embeddings use:
 *
 *   @huggingface/tokenizers
 *   + onnxruntime-web
 *   + a quantized ONNX MiniLM model
 */
export const LOCAL_EMBEDDING_MODEL =
  "Xenova/all-MiniLM-L6-v2";

export const LOCAL_EMBEDDING_MODEL_FILE =
  "onnx/model_quantized.onnx";

export const LOCAL_EMBEDDING_DIMENSIONS =
  384;

/*
 * Sentence-Transformers truncates this model to 256
 * tokens. Keeping that limit also bounds local CPU/RAM
 * use during large rebuilds.
 */
export const LOCAL_EMBEDDING_MAX_TOKENS =
  256;

export const LOCAL_EMBEDDING_IDENTITY =
  [
    "onnxruntime-web",
    LOCAL_EMBEDDING_MODEL,
    "model_quantized",
    `max${LOCAL_EMBEDDING_MAX_TOKENS}`,
    "attention-mask-mean-pooling",
    "l2-normalized",
    "v1",
  ].join(":");

export function getEmbeddingDescriptor(
  settings:
    LocalVaultAISettings,
): EmbeddingDescriptor {
  if (
    settings
      .useLocalEmbeddings
  ) {
    return {
      provider:
        "local",

      identity:
        `local:${LOCAL_EMBEDDING_IDENTITY}`,

      displayName:
        `Local — ${LOCAL_EMBEDDING_MODEL} (quantized ONNX)`,
    };
  }

  const model =
    settings
      .embeddingModel
      .trim();

  return {
    provider:
      "ollama",

    identity:
      `ollama:${model}`,

    displayName:
      `Ollama — ${model}`,
  };
}
