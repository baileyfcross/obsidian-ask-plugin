import { OllamaClient } from "./OllamaClient";

export type ModelJobKind =
  | "index-rebuild"
  | "index-update"
  | "chat"
  | "lecture"
  | "other";

export interface ModelJobRequest {
  kind: ModelJobKind;
  label: string;
  models: string[];
}

export interface ActiveModelJob {
  id: string;
  kind: ModelJobKind;
  label: string;
  models: string[];
  startedAt: string;
}

export interface ModelRuntimeState {
  model: string;
  activeLeaseCount: number;
  activeJobs: ActiveModelJob[];
  unloadQueued: boolean;
  unloadInFlight: boolean;
  lastUnloadError?: string;
}

export type ModelUnloadStatus =
  | "unloaded"
  | "not-loaded"
  | "queued";

export interface ModelUnloadResult {
  model: string;
  status: ModelUnloadStatus;
}

export interface ModelJobLease {
  readonly job: ActiveModelJob;
  release(): Promise<void>;
}

interface InternalModelState {
  jobIds: Set<string>;
  unloadQueued: boolean;
  unloadInFlight: boolean;
  lastUnloadError?: string;
}

export class ModelUnloadPendingError extends Error {
  constructor(
    public readonly model: string,
  ) {
    super(
      `Model "${model}" is scheduled to unload. ` +
        "Wait for the unload to finish or cancel the queued unload before starting new work.",
    );

    this.name = "ModelUnloadPendingError";
  }
}

/**
 * Coordinates model usage at the level of complete plugin jobs.
 *
 * A lease covers the entire operation:
 * - full index rebuild
 * - single-note index update
 * - complete RAG chat request
 * - complete lecture generation request
 *
 * This prevents a model from being unloaded in a gap
 * between two HTTP requests that belong to the same job.
 */
export class ModelRuntimeManager {
  private readonly jobs =
    new Map<string, ActiveModelJob>();

  private readonly states =
    new Map<string, InternalModelState>();

  constructor(
    private readonly ollama: OllamaClient,
  ) {}

  acquireJob(
    request: ModelJobRequest,
  ): ModelJobLease {
    const models =
      this.uniqueModels(request.models);

    /*
     * No await occurs before these checks and state
     * mutations, so an unload request cannot interleave
     * halfway through acquisition on the JS event loop.
     */
    for (const model of models) {
      const state = this.getInternalState(model);

      if (
        state.unloadQueued ||
        state.unloadInFlight
      ) {
        throw new ModelUnloadPendingError(
          model,
        );
      }
    }

    const job: ActiveModelJob = {
      id: crypto.randomUUID(),
      kind: request.kind,
      label: request.label,
      models,
      startedAt:
        new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    for (const model of models) {
      this.getInternalState(model)
        .jobIds.add(job.id);
    }

    let released = false;

    return {
      job,

      release: async () => {
        if (released) {
          return;
        }

        released = true;

        await this.releaseJob(job.id);
      },
    };
  }

  getActiveJobs(): ActiveModelJob[] {
    return Array.from(
      this.jobs.values(),
    );
  }

  getModelState(
    model: string,
  ): ModelRuntimeState {
    const state =
      this.getInternalState(model);

    const activeJobs =
      Array.from(state.jobIds)
        .map((jobId) =>
          this.jobs.get(jobId),
        )
        .filter(
          (
            job,
          ): job is ActiveModelJob =>
            Boolean(job),
        );

    return {
      model,
      activeLeaseCount:
        state.jobIds.size,
      activeJobs,
      unloadQueued:
        state.unloadQueued,
      unloadInFlight:
        state.unloadInFlight,
      lastUnloadError:
        state.lastUnloadError,
    };
  }

  getModelStates(
    models: string[],
  ): ModelRuntimeState[] {
    return this.uniqueModels(models).map(
      (model) =>
        this.getModelState(model),
    );
  }

  /**
   * Requests safe unloading.
   *
   * Important race guard:
   * every requested model is marked unloadQueued before
   * any asynchronous Ollama call begins. Therefore new
   * jobs cannot acquire that model while the unload is
   * being decided or performed.
   */
  async requestUnload(
    models: string[],
  ): Promise<ModelUnloadResult[]> {
    const unique =
      this.uniqueModels(models);

    for (const model of unique) {
      const state =
        this.getInternalState(model);

      state.unloadQueued = true;
      state.lastUnloadError =
        undefined;
    }

    const results:
      ModelUnloadResult[] = [];

    for (const model of unique) {
      const state =
        this.getInternalState(model);

      if (state.jobIds.size > 0) {
        results.push({
          model,
          status: "queued",
        });

        continue;
      }

      const status =
        await this.performQueuedUnload(
          model,
        );

      results.push({
        model,
        status,
      });
    }

    return results;
  }

  /**
   * Cancels queued unloads that have not begun their
   * actual Ollama unload request yet.
   */
  cancelQueuedUnloads(
    models?: string[],
  ): number {
    const targets = models
      ? this.uniqueModels(models)
      : Array.from(
          this.states.keys(),
        );

    let cancelled = 0;

    for (const model of targets) {
      const state =
        this.getInternalState(model);

      if (
        state.unloadQueued &&
        !state.unloadInFlight
      ) {
        state.unloadQueued = false;
        cancelled += 1;
      }
    }

    return cancelled;
  }

  private async releaseJob(
    jobId: string,
  ): Promise<void> {
    const job =
      this.jobs.get(jobId);

    if (!job) {
      return;
    }

    /*
     * Remove the job from every model synchronously
     * before starting any async unload.
     */
    this.jobs.delete(jobId);

    const shouldUnload: string[] = [];

    for (const model of job.models) {
      const state =
        this.getInternalState(model);

      state.jobIds.delete(jobId);

      if (
        state.jobIds.size === 0 &&
        state.unloadQueued &&
        !state.unloadInFlight
      ) {
        shouldUnload.push(model);
      }
    }

    /*
     * A failed cleanup unload should not turn a
     * successfully completed chat/index/lecture job
     * into a user-visible failure.
     */
    await Promise.all(
      shouldUnload.map(
        async (model) => {
          try {
            await this.performQueuedUnload(
              model,
            );
          } catch (error) {
            console.error(
              `[Local Vault AI] Deferred unload failed for "${model}".`,
              error,
            );
          }
        },
      ),
    );
  }

  private async performQueuedUnload(
    model: string,
  ): Promise<
    "unloaded" | "not-loaded"
  > {
    const state =
      this.getInternalState(model);

    if (!state.unloadQueued) {
      return "not-loaded";
    }

    if (state.jobIds.size > 0) {
      throw new Error(
        `Refusing to unload "${model}" because it still has an active job lease.`,
      );
    }

    if (state.unloadInFlight) {
      return "not-loaded";
    }

    state.unloadInFlight = true;

    try {
      const result =
        await this.ollama.unloadModel(
          model,
        );

      state.unloadQueued = false;
      state.lastUnloadError =
        undefined;

      return result;
    } catch (error) {
      state.unloadQueued = false;
      state.lastUnloadError =
        error instanceof Error
          ? error.message
          : String(error);

      throw error;
    } finally {
      state.unloadInFlight = false;
    }
  }

  private getInternalState(
    model: string,
  ): InternalModelState {
    let state =
      this.states.get(model);

    if (!state) {
      state = {
        jobIds: new Set<string>(),
        unloadQueued: false,
        unloadInFlight: false,
      };

      this.states.set(
        model,
        state,
      );
    }

    return state;
  }

  private uniqueModels(
    models: string[],
  ): string[] {
    return Array.from(
      new Set(
        models
          .map((model) =>
            model.trim(),
          )
          .filter(Boolean),
      ),
    );
  }
}
