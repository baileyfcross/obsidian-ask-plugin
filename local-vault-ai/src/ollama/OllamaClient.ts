import { requestUrl } from "obsidian";
import * as http from "node:http";
import * as https from "node:https";

export interface OllamaModel {
  name: string;
  model: string;
  size?: number;
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  context_length?: number;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type OllamaThinkOption =
  | boolean
  | "low"
  | "medium"
  | "high"
  | "max";

export interface OllamaChatOptions {
  keepAlive?: string | number;
  think?: OllamaThinkOption;
}

export interface OllamaChatResult {
  content: string;
  thinking?: string;
}

export interface OllamaChatStreamCallbacks {
  onThinking?: (
    delta: string,
    accumulated: string,
  ) => void;

  onContent?: (
    delta: string,
    accumulated: string,
  ) => void;
}

interface TagsResponse {
  models?: OllamaModel[];
}

interface RunningModelsResponse {
  models?: OllamaRunningModel[];
}

interface EmbedResponse {
  embeddings?: number[][];
}

interface ChatResponse {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
}

interface ChatStreamChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };

  done?: boolean;
  done_reason?: string;

  error?: string;
}

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl =
      this.cleanBaseUrl(baseUrl);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl =
      this.cleanBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async isAvailable():
    Promise<boolean> {
    try {
      const response =
        await requestUrl({
          url:
            `${this.baseUrl}/api/tags`,
          method: "GET",
        });

      return (
        response.status >= 200 &&
        response.status < 300
      );
    } catch {
      return false;
    }
  }

  async listModels():
    Promise<OllamaModel[]> {
    try {
      const response =
        await requestUrl({
          url:
            `${this.baseUrl}/api/tags`,
          method: "GET",
        });

      if (response.status >= 400) {
        throw new Error(
          `Ollama returned HTTP ${response.status}.`,
        );
      }

      const payload =
        response.json as TagsResponse;

      return payload.models ?? [];
    } catch (error) {
      throw new Error(
        `Could not connect to Ollama at ${this.baseUrl}. ` +
          `Make sure Ollama is running. ${this.errorText(error)}`,
      );
    }
  }

  async listRunningModels():
    Promise<OllamaRunningModel[]> {
    try {
      const response =
        await requestUrl({
          url:
            `${this.baseUrl}/api/ps`,
          method: "GET",
        });

      if (response.status >= 400) {
        throw new Error(
          `Ollama returned HTTP ${response.status}.`,
        );
      }

      const payload =
        response.json as
          RunningModelsResponse;

      return payload.models ?? [];
    } catch (error) {
      throw new Error(
        `Could not retrieve loaded Ollama models. ` +
          `${this.errorText(error)}`,
      );
    }
  }

  async modelExists(
    name: string,
  ): Promise<boolean> {
    const models =
      await this.listModels();

    return models.some(
      (model) =>
        this.modelNamesMatch(
          name,
          model.name,
        ) ||
        this.modelNamesMatch(
          name,
          model.model,
        ),
    );
  }

  async embed(
    model: string,
    input: string[],
  ): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }

    try {
      const response =
        await requestUrl({
          url:
            `${this.baseUrl}/api/embed`,
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify({
              model,
              input,
            }),
        });

      if (response.status >= 400) {
        throw new Error(
          `Ollama returned HTTP ${response.status}.`,
        );
      }

      const payload =
        response.json as EmbedResponse;

      if (!payload.embeddings) {
        throw new Error(
          "Ollama returned no embeddings.",
        );
      }

      return payload.embeddings;
    } catch (error) {
      throw new Error(
        `Embedding request failed for model "${model}". ` +
          `${this.errorText(error)}`,
      );
    }
  }

  async embeddingDimension(
    model: string,
  ): Promise<number> {
    const embeddings =
      await this.embed(
        model,
        [
          "Local Vault AI embedding dimension probe.",
        ],
      );

    const vector =
      embeddings[0];

    if (
      !vector ||
      vector.length === 0
    ) {
      throw new Error(
        `Embedding model "${model}" returned an empty vector.`,
      );
    }

    return vector.length;
  }

  /**
   * Backward-compatible non-streaming API.
   *
   * LectureService and any structured-output
   * workflow can continue using this method.
   */
  async chat(
    model: string,
    messages:
      OllamaChatMessage[],
    options?:
      OllamaChatOptions,
  ): Promise<string> {
    const result =
      await this.chatWithThinking(
        model,
        messages,
        options,
      );

    return result.content;
  }

  /**
   * Non-streaming API that returns both the
   * final answer and Ollama's reasoning field.
   */
  async chatWithThinking(
    model: string,
    messages:
      OllamaChatMessage[],
    options?:
      OllamaChatOptions,
  ): Promise<OllamaChatResult> {
    try {
      const body:
        Record<string, unknown> = {
          model,
          stream: false,
          messages,
        };

      if (
        options?.keepAlive !==
        undefined
      ) {
        body.keep_alive =
          options.keepAlive;
      }

      if (
        options?.think !==
        undefined
      ) {
        body.think =
          options.think;
      }

      const response =
        await requestUrl({
          url:
            `${this.baseUrl}/api/chat`,
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify(body),
        });

      if (response.status >= 400) {
        throw new Error(
          `Ollama returned HTTP ${response.status}.`,
        );
      }

      const payload =
        response.json as ChatResponse;

      const content =
        payload.message?.content;

      if (!content) {
        throw new Error(
          "Ollama returned an empty chat response.",
        );
      }

      const thinking =
        payload.message?.thinking
          ?.trim();

      return {
        content,
        thinking:
          thinking &&
          thinking.length > 0
            ? thinking
            : undefined,
      };
    } catch (error) {
      throw new Error(
        `Chat request failed for model "${model}". ` +
          `${this.errorText(error)}`,
      );
    }
  }

  /**
   * Streams Ollama's newline-delimited JSON response.
   *
   * This path intentionally uses Node's HTTP client.
   * Local Vault AI is already desktop-only, and
   * Obsidian's requestUrl() buffers the complete
   * response instead of exposing a readable stream.
   */
  async chatStreamWithThinking(
    model: string,
    messages:
      OllamaChatMessage[],
    options?:
      OllamaChatOptions,
    callbacks?:
      OllamaChatStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<OllamaChatResult> {
    const url =
      new URL(
        `${this.baseUrl}/api/chat`,
      );

    const requestBody:
      Record<string, unknown> = {
        model,
        stream: true,
        messages,
      };

    if (
      options?.keepAlive !==
      undefined
    ) {
      requestBody.keep_alive =
        options.keepAlive;
    }

    if (
      options?.think !==
      undefined
    ) {
      requestBody.think =
        options.think;
    }

    const serialized =
      JSON.stringify(requestBody);

    const transport =
      url.protocol === "https:"
        ? https
        : http;

    return await new Promise<
      OllamaChatResult
    >((resolve, reject) => {
      let settled = false;
      let thinking = "";
      let content = "";
      let buffer = "";

      const finishReject = (
        error: unknown,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;

        reject(
          error instanceof Error
            ? error
            : new Error(
                String(error),
              ),
        );
      };

      const finishResolve =
        (): void => {
          if (settled) {
            return;
          }

          settled = true;

          const trimmedThinking =
            thinking.trim();

          resolve({
            content,
            thinking:
              trimmedThinking.length >
              0
                ? trimmedThinking
                : undefined,
          });
        };

      const request =
        transport.request(
          {
            protocol:
              url.protocol,
            hostname:
              url.hostname,
            port:
              url.port ||
              (url.protocol ===
              "https:"
                ? 443
                : 80),
            path:
              `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
              Accept:
                "application/x-ndjson",
              "Content-Length":
                Buffer.byteLength(
                  serialized,
                  "utf8",
                ),
            },
          },
          (response) => {
            response.setEncoding(
              "utf8",
            );

            if (
              response.statusCode &&
              response.statusCode >=
                400
            ) {
              let errorBody = "";

              response.on(
                "data",
                (chunk: string) => {
                  errorBody += chunk;
                },
              );

              response.on(
                "end",
                () => {
                  finishReject(
                    new Error(
                      `Ollama returned HTTP ${response.statusCode}. ` +
                        errorBody.trim(),
                    ),
                  );
                },
              );

              return;
            }

            const handleLine = (
              line: string,
            ): void => {
              const trimmed =
                line.trim();

              if (!trimmed) {
                return;
              }

              let chunk:
                ChatStreamChunk;

              try {
                chunk =
                  JSON.parse(
                    trimmed,
                  ) as
                    ChatStreamChunk;
              } catch (error) {
                finishReject(
                  new Error(
                    `Could not parse Ollama stream chunk: ${this.errorText(error)}`,
                  ),
                );
                request.destroy();
                return;
              }

              if (chunk.error) {
                finishReject(
                  new Error(
                    chunk.error,
                  ),
                );
                request.destroy();
                return;
              }

              const thinkingDelta =
                chunk.message
                  ?.thinking ?? "";

              if (
                thinkingDelta.length >
                0
              ) {
                thinking +=
                  thinkingDelta;

                try {
                  callbacks
                    ?.onThinking?.(
                      thinkingDelta,
                      thinking,
                    );
                } catch (
                  callbackError
                ) {
                  console.error(
                    "[Local Vault AI] Reasoning stream UI callback failed.",
                    callbackError,
                  );
                }
              }

              const contentDelta =
                chunk.message
                  ?.content ?? "";

              if (
                contentDelta.length >
                0
              ) {
                content +=
                  contentDelta;

                try {
                  callbacks
                    ?.onContent?.(
                      contentDelta,
                      content,
                    );
                } catch (
                  callbackError
                ) {
                  console.error(
                    "[Local Vault AI] Answer stream UI callback failed.",
                    callbackError,
                  );
                }
              }
            };

            response.on(
              "data",
              (chunk: string) => {
                buffer += chunk;

                let newlineIndex =
                  buffer.indexOf(
                    "\n",
                  );

                while (
                  newlineIndex >= 0
                ) {
                  const line =
                    buffer.slice(
                      0,
                      newlineIndex,
                    );

                  buffer =
                    buffer.slice(
                      newlineIndex +
                        1,
                    );

                  handleLine(line);

                  if (settled) {
                    return;
                  }

                  newlineIndex =
                    buffer.indexOf(
                      "\n",
                    );
                }
              },
            );

            response.on(
              "end",
              () => {
                if (settled) {
                  return;
                }

                if (
                  buffer.trim()
                    .length > 0
                ) {
                  handleLine(
                    buffer,
                  );
                }

                if (settled) {
                  return;
                }

                if (
                  content.length ===
                  0
                ) {
                  finishReject(
                    new Error(
                      "Ollama completed the stream without returning an answer.",
                    ),
                  );
                  return;
                }

                finishResolve();
              },
            );

            response.on(
              "aborted",
              () => {
                finishReject(
                  new Error(
                    "Ollama response stream was aborted.",
                  ),
                );
              },
            );

            response.on(
              "error",
              (error) => {
                finishReject(
                  error,
                );
              },
            );
          },
        );

      request.on(
        "error",
        (error) => {
          finishReject(error);
        },
      );

      const abortHandler =
        (): void => {
          request.destroy(
            new Error(
              "Request cancelled.",
            ),
          );
        };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
          return;
        }

        signal.addEventListener(
          "abort",
          abortHandler,
          {
            once: true,
          },
        );

        request.once(
          "close",
          () => {
            signal.removeEventListener(
              "abort",
              abortHandler,
            );
          },
        );
      }

      request.write(serialized);
      request.end();
    }).catch((error) => {
      throw new Error(
        `Streaming chat request failed for model "${model}". ` +
          `${this.errorText(error)}`,
      );
    });
  }

  /**
   * Immediately unloads a model that is already
   * known to be safe to stop.
   *
   * Job-safety decisions belong to
   * ModelRuntimeManager.
   */
  async unloadModel(
    model: string,
  ): Promise<
    "unloaded" | "not-loaded"
  > {
    const running =
      await this.listRunningModels();

    const loaded =
      running.some(
        (item) =>
          this.modelNamesMatch(
            model,
            item.name,
          ) ||
          this.modelNamesMatch(
            model,
            item.model,
          ),
      );

    if (!loaded) {
      return "not-loaded";
    }

    const response =
      await requestUrl({
        url:
          `${this.baseUrl}/api/generate`,
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify({
            model,
            stream: false,
            keep_alive: 0,
          }),
      });

    if (response.status >= 400) {
      throw new Error(
        `Could not unload "${model}". ` +
          `Ollama returned HTTP ${response.status}.`,
      );
    }

    return "unloaded";
  }

  modelNamesMatch(
    configured: string,
    returned: string,
  ): boolean {
    if (configured === returned) {
      return true;
    }

    if (
      !configured.includes(":")
    ) {
      return (
        returned ===
        `${configured}:latest`
      );
    }

    if (
      !returned.includes(":")
    ) {
      return (
        configured ===
        `${returned}:latest`
      );
    }

    return false;
  }

  private cleanBaseUrl(
    value: string,
  ): string {
    const trimmed =
      value.trim();

    return trimmed.endsWith("/")
      ? trimmed.slice(0, -1)
      : trimmed;
  }

  private errorText(
    error: unknown,
  ): string {
    if (
      error instanceof Error
    ) {
      return error.message;
    }

    return String(error);
  }
}
