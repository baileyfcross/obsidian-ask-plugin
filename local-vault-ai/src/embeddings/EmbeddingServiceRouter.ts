import {
  DataAdapter,
} from "obsidian";
import {
  OllamaClient,
} from "../ollama/OllamaClient";
import type {
  LocalVaultAISettings,
} from "../settings/Settings";
import {
  EmbeddingDescriptor,
  EmbeddingService,
  getEmbeddingDescriptor,
} from "./EmbeddingService";
import {
  LocalEmbeddingService,
} from "./LocalEmbeddingService";
import {
  OllamaEmbeddingService,
} from "./OllamaEmbeddingService";

/*
 * IMPORTANT:
 * This router decides ONLY where embeddings are created.
 * It does not route any generative model request.
 *
 * - local mode: document + query embeddings run locally
 * - Ollama mode: document + query embeddings use /api/embed
 *
 * Chat, reasoning, lecture generation, and every other
 * generative job continue to call OllamaClient directly.
 */
export class EmbeddingServiceRouter
  implements
    EmbeddingService {
  private readonly local:
    LocalEmbeddingService;

  constructor(
    private readonly settings:
      LocalVaultAISettings,

    private readonly ollama:
      OllamaClient,

    adapter:
      DataAdapter,

    localCacheDir:
      string,
  ) {
    this.local =
      new LocalEmbeddingService(
        adapter,
        localCacheDir,
      );
  }

  getDescriptor():
    EmbeddingDescriptor {
    return getEmbeddingDescriptor(
      this.settings,
    );
  }

  usesLocalEmbeddings():
    boolean {
    return this.settings
      .useLocalEmbeddings;
  }

  getOllamaModelName():
    string | null {
    if (
      this.usesLocalEmbeddings()
    ) {
      return null;
    }

    const model =
      this.settings
        .embeddingModel
        .trim();

    return model || null;
  }

  async validate():
    Promise<void> {
    await this
      .activeService()
      .validate();
  }

  async embeddingDimension():
    Promise<number> {
    return this
      .activeService()
      .embeddingDimension();
  }

  async embed(
    input: string[],
  ): Promise<number[][]> {
    return this
      .activeService()
      .embed(input);
  }

  private activeService():
    EmbeddingService {
    if (
      this.usesLocalEmbeddings()
    ) {
      return this.local;
    }

    const model =
      this.settings
        .embeddingModel
        .trim();

    if (!model) {
      throw new Error(
        "No Ollama embedding model is configured.",
      );
    }

    return new OllamaEmbeddingService(
      this.ollama,
      model,
    );
  }
}
