import {
  AsyncSemaphore,
} from "./Concurrency";

const FILESYSTEM_RETRY_DELAYS_MS =
  [
    250,
    750,
    1500,
  ];

const FILESYSTEM_MAX_ATTEMPTS =
  FILESYSTEM_RETRY_DELAYS_MS.length +
  1;

export class FileSystemOperationError
  extends Error {
  constructor(
    public readonly operation:
      string,

    public readonly target:
      string,

    public readonly attempt:
      number,

    public readonly maxAttempts:
      number,

    public readonly originalError:
      unknown,
  ) {
    super(
      `Filesystem failure while ${operation} "${target}" ` +
        `(attempt ${attempt} of ${maxAttempts}): ` +
        errorText(originalError),
    );

    this.name =
      "FileSystemOperationError";
  }
}

/**
 * Limits concurrent vault/plugin filesystem operations and retries
 * transient Obsidian/Electron filesystem timeouts with backoff.
 *
 * CPU work, PDF text extraction, chunking, local ONNX inference,
 * Ollama requests, and Orama in-memory mutation do NOT use this gate.
 */
export class FileSystemGate {
  private semaphore:
    AsyncSemaphore;

  constructor(
    concurrency:
      number,
  ) {
    this.semaphore =
      new AsyncSemaphore(
        normalizeConcurrency(
          concurrency,
        ),
      );
  }

  getActiveCount():
    number {
    return this.semaphore
      .getActiveCount();
  }

  setConcurrency(
    concurrency:
      number,
  ): void {
    /*
     * IndexManager only calls this when settings change
     * outside a running rebuild. Existing operations
     * retain their old semaphore; future ones use this
     * new limiter.
     */
    this.semaphore =
      new AsyncSemaphore(
        normalizeConcurrency(
          concurrency,
        ),
      );
  }

  async run<T>(
    operation:
      string,

    target:
      string,

    task:
      () => Promise<T>,
  ): Promise<T> {
    let lastError:
      unknown = null;

    for (
      let attempt = 1;
      attempt <=
      FILESYSTEM_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        /*
         * Acquire the filesystem slot only while the
         * actual I/O operation is running. Backoff waits
         * happen after the slot has been released.
         */
        return await this
          .semaphore
          .run(task);
      } catch (error) {
        lastError =
          error;

        const retryable =
          isRetryableFileSystemError(
            error,
          );

        if (
          !retryable ||
          attempt >=
          FILESYSTEM_MAX_ATTEMPTS
        ) {
          throw new FileSystemOperationError(
            operation,
            target,
            attempt,
            FILESYSTEM_MAX_ATTEMPTS,
            error,
          );
        }

        const delay =
          FILESYSTEM_RETRY_DELAYS_MS[
            attempt - 1
          ] ??
          1500;

        console.warn(
          `[Local Vault AI] Filesystem retry ${attempt + 1}/${FILESYSTEM_MAX_ATTEMPTS}: ` +
            `${operation} "${target}" after ${delay} ms. ` +
            errorText(error),
        );

        await sleep(delay);
      }
    }

    /*
     * Defensive fallback. The loop always returns or
     * throws, but keeping this explicit gives callers a
     * useful failure if that behavior ever changes.
     */
    throw new FileSystemOperationError(
      operation,
      target,
      FILESYSTEM_MAX_ATTEMPTS,
      FILESYSTEM_MAX_ATTEMPTS,
      lastError,
    );
  }
}

function normalizeConcurrency(
  value:
    number,
): number {
  if (
    !Number.isFinite(value)
  ) {
    return 2;
  }

  return Math.max(
    1,
    Math.min(
      4,
      Math.floor(value),
    ),
  );
}

function isRetryableFileSystemError(
  error:
    unknown,
): boolean {
  const text =
    errorText(error)
      .toLowerCase();

  /*
   * Obsidian/Electron's exact timeout message is:
   * "File system operation timed out."
   *
   * Include a few common transient filesystem variants,
   * but do not retry permanent errors such as ENOENT.
   */
  return (
    text.includes(
      "file system operation timed out",
    ) ||
    text.includes(
      "filesystem operation timed out",
    ) ||
    text.includes(
      "operation timed out",
    ) ||
    text.includes(
      "ebusy",
    ) ||
    text.includes(
      "resource busy",
    ) ||
    text.includes(
      "temporarily unavailable",
    )
  );
}

function errorText(
  error:
    unknown,
): string {
  if (
    error instanceof
    Error
  ) {
    return error.message;
  }

  return String(error);
}

async function sleep(
  milliseconds:
    number,
): Promise<void> {
  await new Promise<void>(
    (resolve) => {
      window.setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
}
