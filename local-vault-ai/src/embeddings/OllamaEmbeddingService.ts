import {
  OllamaClient,
} from "../ollama/OllamaClient";
import {
  EmbeddingDescriptor,
  EmbeddingService,
} from "./EmbeddingService";

export class OllamaEmbeddingService
  implements
    EmbeddingService {
  constructor(
    private readonly ollama:
      OllamaClient,

    private readonly model:
      string,
  ) {}

  getDescriptor():
    EmbeddingDescriptor {
    return {
      provider:
        "ollama",

      identity:
        `ollama:${this.model}`,

      displayName:
        `Ollama — ${this.model}`,
    };
  }

  async validate():
    Promise<void> {
    const available =
      await this.ollama
        .isAvailable();

    if (!available) {
      throw new Error(
        `Ollama is offline. Could not connect to ${this.ollama.getBaseUrl()}.`,
      );
    }

    const exists =
      await this.ollama
        .modelExists(
          this.model,
        );

    if (!exists) {
      throw new Error(
        `Embedding model "${this.model}" is not installed in Ollama. ` +
          `Run: ollama pull ${this.model}`,
      );
    }
  }

  async embeddingDimension():
    Promise<number> {
    return this.ollama
      .embeddingDimension(
        this.model,
      );
  }

  async embed(
    input: string[],
  ): Promise<number[][]> {
    return this.ollama.embed(
      this.model,
      input,
    );
  }
}
