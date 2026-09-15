import {
  OllamaClient,
  OllamaModel,
  OllamaModelInfo,
} from "./OllamaClient";

export type OllamaModelPurpose =
  | "generation"
  | "embedding";

export type OllamaModelCatalogStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface OllamaModelCatalogEntry {
  name: string;
  model: string;
  size?: number;
  parameterSize?: string;
  quantizationLevel?: string;
  family?: string;
  capabilities?: string[];
  detailsResolved: boolean;
  detailsError?: string;
}

export interface OllamaModelCatalogSnapshot {
  status:
    OllamaModelCatalogStatus;

  serverUrl:
    string;

  models:
    OllamaModelCatalogEntry[];

  error?: string;

  refreshedAt?: string;
}

/**
 * Retrieves and caches the installed model catalog from
 * the currently configured Ollama server.
 *
 * /api/tags provides the installed model list.
 * /api/show provides capabilities/metadata and does not
 * run the model.
 *
 * The settings UI consumes this class instead of owning
 * API calls or model-classification logic itself.
 */
export class OllamaModelCatalog {
  private snapshot:
    OllamaModelCatalogSnapshot;

  private activeRefresh:
    Promise<
      OllamaModelCatalogSnapshot
    > | null = null;

  constructor(
    private readonly ollama:
      OllamaClient,
  ) {
    this.snapshot = {
      status:
        "idle",

      serverUrl:
        this.ollama
          .getBaseUrl(),

      models: [],
    };
  }

  getSnapshot():
    OllamaModelCatalogSnapshot {
    this.invalidateIfServerChanged();

    return {
      ...this.snapshot,

      models:
        this.snapshot.models
          .map(
            (model) => ({
              ...model,

              capabilities:
                model.capabilities
                  ? [
                      ...model
                        .capabilities,
                    ]
                  : undefined,
            }),
          ),
    };
  }

  /**
   * Returns models appropriate for a particular setting.
   *
   * Unknown-capability models remain visible so older
   * Ollama servers do not make valid models disappear.
   */
  getModelsFor(
    purpose:
      OllamaModelPurpose,
  ): OllamaModelCatalogEntry[] {
    this.invalidateIfServerChanged();

    const entries =
      this.snapshot.models;

    if (
      entries.length ===
      0
    ) {
      return [];
    }

    const known =
      entries.filter(
        (entry) =>
          entry.capabilities !==
            undefined,
      );

    const unknown =
      entries.filter(
        (entry) =>
          entry.capabilities ===
            undefined,
      );

    if (
      purpose ===
      "generation"
    ) {
      const compatible =
        known.filter(
          (entry) =>
            this.hasCapability(
              entry,
              "completion",
            ),
        );

      /*
       * Most old Ollama models are completion models.
       * Keep unknown entries available as a safe
       * backwards-compatible fallback.
       */
      const combined = [
        ...compatible,
        ...unknown,
      ];

      return combined.length >
        0
        ? combined
        : [
            ...entries,
          ];
    }

    const compatible =
      known.filter(
        (entry) =>
          this.hasCapability(
            entry,
            "embedding",
          ),
      );

    /*
     * If the server reports capability metadata and no
     * embedding-capable models exist, return only unknown
     * entries rather than showing known completion-only
     * models as embedding choices.
     */
    if (
      compatible.length ===
        0 &&
      unknown.length ===
        0
    ) {
      return [];
    }

    return [
      ...compatible,
      ...unknown,
    ];
  }

  async refresh():
    Promise<
      OllamaModelCatalogSnapshot
    > {
    this.invalidateIfServerChanged();

    if (
      this.activeRefresh
    ) {
      return await this
        .activeRefresh;
    }

    const serverUrl =
      this.ollama
        .getBaseUrl();

    this.snapshot = {
      ...this.snapshot,

      status:
        "loading",

      serverUrl,

      error:
        undefined,
    };

    this.activeRefresh =
      this.performRefresh(
        serverUrl,
      );

    try {
      return await this
        .activeRefresh;
    } finally {
      this.activeRefresh =
        null;
    }
  }

  invalidate(): void {
    this.snapshot = {
      status:
        "idle",

      serverUrl:
        this.ollama
          .getBaseUrl(),

      models: [],
    };
  }

  formatOptionLabel(
    entry:
      OllamaModelCatalogEntry,
  ): string {
    const metadata:
      string[] = [];

    if (
      entry.parameterSize
    ) {
      metadata.push(
        entry.parameterSize,
      );
    }

    if (
      entry.quantizationLevel
    ) {
      metadata.push(
        entry
          .quantizationLevel,
      );
    }

    if (
      this.hasCapability(
        entry,
        "embedding",
      )
    ) {
      metadata.push(
        "embedding",
      );
    } else if (
      this.hasCapability(
        entry,
        "completion",
      )
    ) {
      metadata.push(
        "generation",
      );
    }

    if (
      metadata.length ===
      0
    ) {
      return entry.name;
    }

    return (
      `${entry.name} — ` +
      metadata.join(
        " · ",
      )
    );
  }

  private async performRefresh(
    serverUrl:
      string,
  ): Promise<
    OllamaModelCatalogSnapshot
  > {
    try {
      const installed =
        await this.ollama
          .listModels();

      const models =
        await this
          .inspectModels(
            installed,
          );

      /*
       * If the server URL changed while requests were in
       * flight, discard these stale results.
       */
      if (
        serverUrl !==
        this.ollama
          .getBaseUrl()
      ) {
        this.invalidate();

        return this
          .getSnapshot();
      }

      this.snapshot = {
        status:
          "ready",

        serverUrl,

        models:
          this.sortModels(
            models,
          ),

        refreshedAt:
          new Date()
            .toISOString(),
      };

      return this
        .getSnapshot();
    } catch (error) {
      const message =
        this.errorText(
          error,
        );

      /*
       * Preserve an already-loaded model list if a
       * refresh later fails. This prevents a temporary
       * network interruption from clearing dropdowns.
       */
      this.snapshot = {
        ...this.snapshot,

        status:
          "error",

        serverUrl,

        error:
          message,
      };

      throw new Error(
        message,
      );
    }
  }

  private async inspectModels(
    installed:
      OllamaModel[],
  ): Promise<
    OllamaModelCatalogEntry[]
  > {
    return await this
      .mapWithConcurrency(
        installed,
        4,
        async (
          item,
        ) => {
          const base =
            this.fromTag(
              item,
            );

          try {
            const info =
              await this.ollama
                .showModel(
                  item.name,
                );

            return this
              .mergeModelInfo(
                base,
                info,
              );
          } catch (error) {
            /*
             * One unsupported/broken /api/show response
             * must not make the whole catalog unusable.
             */
            return {
              ...base,

              detailsResolved:
                false,

              detailsError:
                this.errorText(
                  error,
                ),
            };
          }
        },
      );
  }

  private fromTag(
    item:
      OllamaModel,
  ): OllamaModelCatalogEntry {
    return {
      name:
        item.name,

      model:
        item.model,

      size:
        item.size,

      parameterSize:
        item.details
          ?.parameter_size,

      quantizationLevel:
        item.details
          ?.quantization_level,

      family:
        item.details
          ?.family,

      capabilities:
        undefined,

      detailsResolved:
        false,
    };
  }

  private mergeModelInfo(
    base:
      OllamaModelCatalogEntry,

    info:
      OllamaModelInfo,
  ): OllamaModelCatalogEntry {
    return {
      ...base,

      parameterSize:
        info.details
          ?.parameter_size ??
        base.parameterSize,

      quantizationLevel:
        info.details
          ?.quantization_level ??
        base.quantizationLevel,

      family:
        info.details
          ?.family ??
        base.family,

      capabilities:
        info.capabilities
          ? Array.from(
              new Set(
                info.capabilities
                  .map(
                    (
                      capability,
                    ) =>
                      capability
                        .trim()
                        .toLowerCase(),
                  )
                  .filter(Boolean),
              ),
            )
          : undefined,

      detailsResolved:
        true,

      detailsError:
        undefined,
    };
  }

  private hasCapability(
    entry:
      OllamaModelCatalogEntry,

    capability:
      string,
  ): boolean {
    return Boolean(
      entry.capabilities
        ?.includes(
          capability,
        ),
    );
  }

  private sortModels(
    entries:
      OllamaModelCatalogEntry[],
  ): OllamaModelCatalogEntry[] {
    const deduplicated =
      new Map<
        string,
        OllamaModelCatalogEntry
      >();

    for (
      const entry of
      entries
    ) {
      if (
        !deduplicated.has(
          entry.name,
        )
      ) {
        deduplicated.set(
          entry.name,
          entry,
        );
      }
    }

    return Array.from(
      deduplicated.values(),
    ).sort(
      (
        left,
        right,
      ) =>
        left.name
          .localeCompare(
            right.name,
            undefined,
            {
              sensitivity:
                "base",
              numeric:
                true,
            },
          ),
    );
  }

  private invalidateIfServerChanged():
    void {
    const current =
      this.ollama
        .getBaseUrl();

    if (
      current ===
      this.snapshot
        .serverUrl
    ) {
      return;
    }

    this.snapshot = {
      status:
        "idle",

      serverUrl:
        current,

      models: [],
    };
  }

  private async mapWithConcurrency<
    TInput,
    TOutput
  >(
    input:
      TInput[],

    concurrency:
      number,

    worker:
      (
        item:
          TInput,
        index:
          number,
      ) => Promise<TOutput>,
  ): Promise<TOutput[]> {
    if (
      input.length ===
      0
    ) {
      return [];
    }

    const results =
      new Array<TOutput>(
        input.length,
      );

    let nextIndex =
      0;

    const workerCount =
      Math.max(
        1,
        Math.min(
          concurrency,
          input.length,
        ),
      );

    const runWorker =
      async (): Promise<void> => {
        while (true) {
          const index =
            nextIndex;

          nextIndex += 1;

          if (
            index >=
            input.length
          ) {
            return;
          }

          /*
           * The loop has already proven:
           *
           *   index < input.length
           *
           * With noUncheckedIndexedAccess enabled,
           * TypeScript still types input[index] as
           * TInput | undefined. The non-null assertion
           * records the runtime invariant established by
           * the bounds check above.
           */
          results[index] =
            await worker(
              input[index]!,
              index,
            );
        }
      };

    await Promise.all(
      Array.from(
        {
          length:
            workerCount,
        },
        () =>
          runWorker(),
      ),
    );

    return results;
  }

  private errorText(
    error:
      unknown,
  ): string {
    if (
      error instanceof
      Error
    ) {
      return error.message;
    }

    return String(
      error,
    );
  }
}
