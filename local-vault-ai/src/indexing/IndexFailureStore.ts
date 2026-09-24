import {
  App,
  TFile,
  normalizePath,
} from "obsidian";

export interface IndexFailureRecord {
  path: string;
  extension: string;
  message: string;
  attempts: number;
  firstFailedAt: number;
  lastFailedAt: number;
}

interface PersistedIndexFailures {
  version: 1;
  failures: IndexFailureRecord[];
}

type FailureListener = () => void;

export class IndexFailureStore {
  private readonly dataDir:
    string;

  private readonly filePath:
    string;

  private readonly failures =
    new Map<
      string,
      IndexFailureRecord
    >();

  private readonly listeners =
    new Set<FailureListener>();

  private writeChain:
    Promise<void> =
    Promise.resolve();

  constructor(
    private readonly app:
      App,
    pluginDir: string,
  ) {
    this.dataDir =
      normalizePath(
        `${pluginDir}/data`,
      );

    this.filePath =
      normalizePath(
        `${this.dataDir}/index-failures.json`,
      );
  }

  async load(): Promise<void> {
    this.failures.clear();

    try {
      if (
        !(
          await this.app
            .vault.adapter
            .exists(
              this.filePath,
            )
        )
      ) {
        return;
      }

      const raw =
        await this.app
          .vault.adapter
          .read(
            this.filePath,
          );

      const parsed =
        JSON.parse(
          raw,
        ) as
          PersistedIndexFailures;

      if (
        parsed.version !== 1 ||
        !Array.isArray(
          parsed.failures,
        )
      ) {
        console.warn(
          "[Local Vault AI] Ignoring invalid index-failures.json.",
        );

        return;
      }

      for (
        const failure of
        parsed.failures
      ) {
        if (!failure?.path) {
          continue;
        }

        this.failures.set(
          failure.path,
          failure,
        );
      }
    } catch (error) {
      console.error(
        "[Local Vault AI] Failed to load index failure history.",
        error,
      );
    }
  }

  get count(): number {
    return this.failures.size;
  }

  getAll():
    IndexFailureRecord[] {
    return Array.from(
      this.failures.values(),
    ).sort(
      (a, b) =>
        b.lastFailedAt -
        a.lastFailedAt,
    );
  }

  has(path: string): boolean {
    return this.failures.has(
      path,
    );
  }

  onChange(
    listener: FailureListener,
  ): () => void {
    this.listeners.add(
      listener,
    );

    return () => {
      this.listeners.delete(
        listener,
      );
    };
  }

  async record(input: {
    path: string;
    extension?: string;
    message: string;
    attempts?: number;
  }): Promise<void> {
    const now = Date.now();

    const existing =
      this.failures.get(
        input.path,
      );

    this.failures.set(
      input.path,
      {
        path:
          input.path,

        extension:
          input.extension ??
          "",

        message:
          input.message,

        attempts:
          Math.max(
            1,
            input.attempts ??
              1,
          ),

        firstFailedAt:
          existing
            ?.firstFailedAt ??
          now,

        lastFailedAt:
          now,
      },
    );

    this.notify();
    await this.queuePersist();
  }

  async clear(
    path: string,
  ): Promise<void> {
    if (
      !this.failures.delete(
        path,
      )
    ) {
      return;
    }

    this.notify();
    await this.queuePersist();
  }

  async pruneMissingSources():
    Promise<void> {
    let changed = false;

    for (
      const path of
      Array.from(
        this.failures.keys(),
      )
    ) {
      const source =
        this.app.vault
          .getAbstractFileByPath(
            path,
          );

      if (
        !(source instanceof TFile)
      ) {
        this.failures.delete(
          path,
        );

        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    this.notify();
    await this.queuePersist();
  }

  private notify(): void {
    for (
      const listener of
      this.listeners
    ) {
      try {
        listener();
      } catch (error) {
        console.error(
          "[Local Vault AI] Index failure listener failed.",
          error,
        );
      }
    }
  }

  private queuePersist():
    Promise<void> {
    this.writeChain =
      this.writeChain
        .then(
          async () => {
            await this.persist();
          },
          async () => {
            await this.persist();
          },
        )
        .catch(
          (error) => {
            /*
             * Failure reporting must never abort the
             * actual knowledge-index operation.
             */
            console.error(
              "[Local Vault AI] Could not save index-failures.json.",
              error,
            );
          },
        );

    return this.writeChain;
  }

  private async persist():
    Promise<void> {
    if (
      !(
        await this.app
          .vault.adapter
          .exists(
            this.dataDir,
          )
      )
    ) {
      await this.app
        .vault.adapter
        .mkdir(
          this.dataDir,
        );
    }

    const payload:
      PersistedIndexFailures = {
      version: 1,
      failures:
        this.getAll(),
    };

    await this.app
      .vault.adapter
      .write(
        this.filePath,
        JSON.stringify(
          payload,
          null,
          2,
        ),
      );
  }
}
