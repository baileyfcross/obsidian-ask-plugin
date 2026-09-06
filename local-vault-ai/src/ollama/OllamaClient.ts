import { requestUrl } from "obsidian";

export interface OllamaModel {
  name: string;
  model: string;
  size?: number;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface TagsResponse {
  models?: OllamaModel[];
}

interface EmbedResponse {
  embeddings?: number[][];
}

interface ChatResponse {
  message?: {
    role?: string;
    content?: string;
  };
}

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = this.cleanBaseUrl(baseUrl);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = this.cleanBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: "GET",
      });

      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: "GET",
      });

      if (response.status >= 400) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
      }

      const payload = response.json as TagsResponse;
      return payload.models ?? [];
    } catch (error) {
      throw new Error(
        `Could not connect to Ollama at ${this.baseUrl}. ` +
          `Make sure Ollama is running. ${this.errorText(error)}`,
      );
    }
  }

  async modelExists(name: string): Promise<boolean> {
    const models = await this.listModels();

    return models.some((model) => {
      if (model.name === name || model.model === name) {
        return true;
      }

      if (!name.includes(":")) {
        return (
          model.name === `${name}:latest` ||
          model.model === `${name}:latest`
        );
      }

      return false;
    });
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }

    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/embed`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input,
        }),
      });

      if (response.status >= 400) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
      }

      const payload = response.json as EmbedResponse;

      if (!payload.embeddings) {
        throw new Error("Ollama returned no embeddings.");
      }

      return payload.embeddings;
    } catch (error) {
      throw new Error(
        `Embedding request failed for model "${model}". ` +
          `${this.errorText(error)}`,
      );
    }
  }

  async embeddingDimension(model: string): Promise<number> {
    const embeddings = await this.embed(model, [
      "Local Vault AI embedding dimension probe.",
    ]);

    const vector = embeddings[0];

    if (!vector || vector.length === 0) {
      throw new Error(
        `Embedding model "${model}" returned an empty vector.`,
      );
    }

    return vector.length;
  }

  async chat(
    model: string,
    messages: OllamaChatMessage[],
  ): Promise<string> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/chat`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
        }),
      });

      if (response.status >= 400) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
      }

      const payload = response.json as ChatResponse;
      const content = payload.message?.content;

      if (!content) {
        throw new Error("Ollama returned an empty chat response.");
      }

      return content;
    } catch (error) {
      throw new Error(
        `Chat request failed for model "${model}". ` +
          `${this.errorText(error)}`,
      );
    }
  }

  private cleanBaseUrl(value: string): string {
    const trimmed = value.trim();
    return trimmed.endsWith("/")
      ? trimmed.slice(0, -1)
      : trimmed;
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
