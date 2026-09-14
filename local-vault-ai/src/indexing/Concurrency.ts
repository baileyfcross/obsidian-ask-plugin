export class AsyncSemaphore {
  private active = 0;

  private readonly waiters:
    Array<() => void> = [];

  constructor(
    private readonly limit:
      number,
  ) {
    if (
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      throw new Error(
        "Semaphore limit must be a positive integer.",
      );
    }
  }

  getActiveCount(): number {
    return this.active;
  }

  async run<T>(
    task:
      () => Promise<T>,
  ): Promise<T> {
    await this.acquire();

    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire():
    Promise<void> {
    if (
      this.active <
      this.limit
    ) {
      this.active += 1;
      return;
    }

    await new Promise<void>(
      (resolve) => {
        this.waiters.push(
          () => {
            this.active += 1;
            resolve();
          },
        );
      },
    );
  }

  private release():
    void {
    this.active =
      Math.max(
        0,
        this.active - 1,
      );

    const next =
      this.waiters.shift();

    if (next) {
      next();
    }
  }
}

export async function runBoundedPool<T>(
  items: T[],
  concurrency: number,
  worker:
    (
      item: T,
      index: number,
    ) => Promise<void>,
): Promise<void> {
  if (
    items.length === 0
  ) {
    return;
  }

  const workerCount =
    Math.max(
      1,
      Math.min(
        Math.floor(
          concurrency,
        ),
        items.length,
      ),
    );

  let nextIndex = 0;

  let firstError:
    unknown = null;

  const runWorker =
    async (): Promise<void> => {
      while (true) {
        if (firstError) {
          return;
        }

        const index =
          nextIndex;

        nextIndex += 1;

        if (
          index >=
          items.length
        ) {
          return;
        }

        const item =
          items[index];

        if (
          item ===
          undefined
        ) {
          continue;
        }

        try {
          await worker(
            item,
            index,
          );
        } catch (error) {
          if (!firstError) {
            firstError =
              error;
          }

          return;
        }
      }
    };

  await Promise.all(
    Array.from(
      {
        length:
          workerCount,
      },
      () => runWorker(),
    ),
  );

  if (firstError) {
    throw firstError;
  }
}
