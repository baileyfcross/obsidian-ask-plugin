import {
  AsyncSemaphore,
  runBoundedPool,
} from "./Concurrency";

export interface PdfPageText {
  pageNumber: number;
  pageLabel?: string;
  lines: string[];
  text: string;
}

export interface ExtractedPdf {
  title?: string;
  pageCount: number;
  pages: PdfPageText[];
  extractedCharacterCount: number;
}

export interface PdfExtractionProgress {
  pageNumber: number;
  pageCount: number;
  activePages: number;
  completedPages: number;
}

export interface PdfExtractionOptions {
  /*
   * Shared across every active PDF during a rebuild.
   * This is what prevents:
   *
   *   3 PDFs × 6 pages each = 18 PDF.js operations
   *
   * The semaphore caps the GLOBAL total instead.
   */
  pageSemaphore?:
    AsyncSemaphore;

  /*
   * Local worker count for this PDF. The shared
   * semaphore remains the final global limit.
   */
  pageConcurrency?:
    number;

  onProgress?: (
    progress:
      PdfExtractionProgress,
  ) => void;
}

export class PdfNoTextError
  extends Error {
  constructor(
    public readonly fileName:
      string,
  ) {
    super(
      `PDF "${fileName}" has no usable text layer. ` +
        "It may be a scanned/image-only PDF. OCR is not enabled.",
    );

    this.name =
      "PdfNoTextError";
  }
}

interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: ArrayLike<number>;
}

interface LoadedPdfJs {
  getDocument:
    typeof import(
      "pdfjs-dist/build/pdf.mjs"
    ).getDocument;

  WorkerMessageHandler:
    unknown;
}

let loadedPdfJs:
  Promise<LoadedPdfJs> | null =
  null;

function defineMethod(
  target: object,
  name: string,
  value: Function,
): void {
  const record =
    target as Record<
      string,
      unknown
    >;

  if (
    typeof record[name] ===
    "function"
  ) {
    return;
  }

  Object.defineProperty(
    target,
    name,
    {
      configurable: true,
      writable: true,
      value,
    },
  );
}

/*
 * Recent pdfjs-dist builds use several newly
 * standardized JavaScript APIs.
 *
 * Obsidian's Electron/Chromium runtime may lag
 * behind those APIs even when npm/typecheck/build
 * succeeds.
 *
 * Install standards-compatible shims BEFORE
 * dynamically importing PDF.js.
 */
function ensurePdfRuntimePolyfills():
  void {
  /*
   * Uint8Array.prototype.toHex()
   */
  defineMethod(
    Uint8Array.prototype,
    "toHex",
    function toHex(
      this: Uint8Array,
    ): string {
      let result = "";

      for (
        let index = 0;
        index <
        this.length;
        index += 1
      ) {
        const byte =
          this[index] ?? 0;

        result +=
          byte
            .toString(16)
            .padStart(
              2,
              "0",
            );
      }

      return result;
    },
  );

  /*
   * Uint8Array.prototype.toBase64()
   */
  defineMethod(
    Uint8Array.prototype,
    "toBase64",
    function toBase64(
      this: Uint8Array,
    ): string {
      let binary = "";

      const chunkSize =
        0x8000;

      for (
        let offset = 0;
        offset <
        this.length;
        offset +=
        chunkSize
      ) {
        const chunk =
          this.subarray(
            offset,
            Math.min(
              offset +
                chunkSize,
              this.length,
            ),
          );

        binary +=
          String.fromCharCode(
            ...chunk,
          );
      }

      return btoa(binary);
    },
  );

  /*
   * Uint8Array.fromHex()
   */
  defineMethod(
    Uint8Array,
    "fromHex",
    function fromHex(
      value: string,
    ): Uint8Array {
      const normalized =
        value.trim();

      if (
        normalized.length %
          2 !==
          0 ||
        !/^[0-9a-f]*$/i.test(
          normalized,
        )
      ) {
        throw new SyntaxError(
          "Invalid hexadecimal string.",
        );
      }

      const result =
        new Uint8Array(
          normalized.length /
            2,
        );

      for (
        let index = 0;
        index <
        result.length;
        index += 1
      ) {
        const pair =
          normalized.slice(
            index * 2,
            index * 2 + 2,
          );

        result[index] =
          Number.parseInt(
            pair,
            16,
          );
      }

      return result;
    },
  );

  /*
   * Uint8Array.fromBase64()
   */
  defineMethod(
    Uint8Array,
    "fromBase64",
    function fromBase64(
      value: string,
    ): Uint8Array {
      const binary =
        atob(value);

      const result =
        new Uint8Array(
          binary.length,
        );

      for (
        let index = 0;
        index <
        binary.length;
        index += 1
      ) {
        result[index] =
          binary.charCodeAt(
            index,
          );
      }

      return result;
    },
  );

  /*
   * Promise.withResolvers()
   */
  defineMethod(
    Promise,
    "withResolvers",
    function withResolvers<
      T,
    >(): {
      promise:
        Promise<T>;
      resolve:
        (
          value:
            T |
            PromiseLike<T>,
        ) => void;
      reject:
        (
          reason?:
            unknown,
        ) => void;
    } {
      let resolve!:
        (
          value:
            T |
            PromiseLike<T>,
        ) => void;

      let reject!:
        (
          reason?:
            unknown,
        ) => void;

      const promise =
        new Promise<T>(
          (
            internalResolve,
            internalReject,
          ) => {
            resolve =
              internalResolve;

            reject =
              internalReject;
          },
        );

      return {
        promise,
        resolve,
        reject,
      };
    },
  );

  /*
   * Map.prototype.getOrInsert()
   *
   * Important: use has(), not get() ?? fallback,
   * because undefined/null can be legitimate
   * existing Map values.
   */
  defineMethod(
    Map.prototype,
    "getOrInsert",
    function getOrInsert<
      K,
      V,
    >(
      this: Map<K, V>,
      key: K,
      defaultValue: V,
    ): V {
      if (this.has(key)) {
        return this.get(
          key,
        ) as V;
      }

      this.set(
        key,
        defaultValue,
      );

      return defaultValue;
    },
  );

  /*
   * Map.prototype.getOrInsertComputed()
   */
  defineMethod(
    Map.prototype,
    "getOrInsertComputed",
    function getOrInsertComputed<
      K,
      V,
    >(
      this: Map<K, V>,
      key: K,
      callback:
        (key: K) => V,
    ): V {
      if (this.has(key)) {
        return this.get(
          key,
        ) as V;
      }

      const value =
        callback(key);

      this.set(
        key,
        value,
      );

      return value;
    },
  );

  /*
   * WeakMap equivalents.
   */
  defineMethod(
    WeakMap.prototype,
    "getOrInsert",
    function getOrInsert<
      K extends object,
      V,
    >(
      this:
        WeakMap<K, V>,
      key: K,
      defaultValue: V,
    ): V {
      if (this.has(key)) {
        return this.get(
          key,
        ) as V;
      }

      this.set(
        key,
        defaultValue,
      );

      return defaultValue;
    },
  );

  defineMethod(
    WeakMap.prototype,
    "getOrInsertComputed",
    function getOrInsertComputed<
      K extends object,
      V,
    >(
      this:
        WeakMap<K, V>,
      key: K,
      callback:
        (key: K) => V,
    ): V {
      if (this.has(key)) {
        return this.get(
          key,
        ) as V;
      }

      const value =
        callback(key);

      this.set(
        key,
        value,
      );

      return value;
    },
  );
}

/*
 * Do not statically import pdfjs-dist here.
 *
 * The compatibility shims MUST exist before
 * PDF.js evaluates. Dynamic import guarantees
 * that ordering.
 */
async function loadPdfJs():
  Promise<LoadedPdfJs> {
  ensurePdfRuntimePolyfills();

  if (!loadedPdfJs) {
    loadedPdfJs =
      Promise.all([
        import(
          "pdfjs-dist/build/pdf.mjs"
        ),

        import(
          "pdfjs-dist/build/pdf.worker.mjs"
        ),
      ]).then(
        (
          [
            pdfModule,
            workerModule,
          ],
        ) => ({
          getDocument:
            pdfModule
              .getDocument,

          WorkerMessageHandler:
            workerModule
              .WorkerMessageHandler,
        }),
      );
  }

  return loadedPdfJs;
}

/*
 * PDF.js normally runs parsing in a Web Worker.
 *
 * Local Vault AI bundles the worker implementation
 * into main.js and exposes WorkerMessageHandler.
 * PDF.js then uses its fake-worker path, avoiding
 * a separate worker file in the Obsidian plugin
 * deployment directory.
 */
function ensureBundledPdfWorker(
  workerMessageHandler:
    unknown,
): void {
  const globalWithWorker =
    globalThis as
      typeof globalThis & {
        pdfjsWorker?: {
          WorkerMessageHandler:
            unknown;
        };
      };

  if (
    !globalWithWorker
      .pdfjsWorker
  ) {
    globalWithWorker
      .pdfjsWorker = {
      WorkerMessageHandler:
        workerMessageHandler,
    };
  }
}

export async function extractPdf(
  bytes: Uint8Array,
  fileName: string,
  options:
    PdfExtractionOptions = {},
): Promise<ExtractedPdf> {
  const {
    getDocument,
    WorkerMessageHandler,
  } =
    await loadPdfJs();

  ensureBundledPdfWorker(
    WorkerMessageHandler,
  );

  /*
   * PDF.js may transfer the supplied Uint8Array.
   * Work on a copy so the caller's buffer remains
   * valid for hashing and diagnostics.
   */
  const data =
    new Uint8Array(bytes);

  const loadingTask =
    getDocument({
      data,
      stopAtErrors: false,
    });

  try {
    const document =
      await loadingTask.promise;

    const pageLabels =
      await document
        .getPageLabels()
        .catch(() => null);

    const metadata =
      await document
        .getMetadata()
        .catch(() => null);

    const title =
      extractPdfTitle(
        metadata?.info,
      );

    /*
     * Allocate by physical page number so completion
     * order never changes document order.
     *
     * Page 38 may finish before page 36, but PdfChunker
     * still receives:
     *
     *   page 36
     *   page 37
     *   page 38
     *
     * in the correct sequence.
     */
    const pages =
      new Array<
        PdfPageText | undefined
      >(
        document.numPages,
      );

    const pageNumbers =
      Array.from(
        {
          length:
            document.numPages,
        },
        (
          _,
          index,
        ) => index + 1,
      );

    const configuredConcurrency =
      Math.max(
        1,
        Math.floor(
          options
            .pageConcurrency ??
            1,
        ),
      );

    /*
     * When no shared limiter is supplied (for example,
     * another future caller), use a local limiter so
     * the same extraction code remains safe.
     */
    const pageSemaphore =
      options.pageSemaphore ??
      new AsyncSemaphore(
        configuredConcurrency,
      );

    let activePages = 0;
    let completedPages = 0;

    const emitProgress =
      (
        pageNumber:
          number,
      ): void => {
        options.onProgress?.({
          pageNumber,
          pageCount:
            document.numPages,
          activePages,
          completedPages,
        });
      };

    await runBoundedPool(
      pageNumbers,
      configuredConcurrency,
      async (
        pageNumber,
      ) => {
        await pageSemaphore.run(
          async () => {
            activePages += 1;

            emitProgress(
              pageNumber,
            );

            let page:
              Awaited<
                ReturnType<
                  typeof document.getPage
                >
              > | null = null;

            try {
              page =
                await document
                  .getPage(
                    pageNumber,
                  );

              const textContent =
                await page
                  .getTextContent();

              const lines =
                reconstructLines(
                  textContent
                    .items as
                    unknown[],
                );

              const text =
                lines
                  .join("\n")
                  .trim();

              const pageLabel =
                pageLabels?.[
                  pageNumber - 1
                ];

              pages[
                pageNumber - 1
              ] = {
                pageNumber,

                pageLabel:
                  typeof pageLabel ===
                  "string"
                    ? pageLabel
                    : undefined,

                lines,
                text,
              };
            } finally {
              page?.cleanup();

              activePages =
                Math.max(
                  0,
                  activePages - 1,
                );

              completedPages +=
                1;

              emitProgress(
                pageNumber,
              );
            }
          },
        );
      },
    );

    const orderedPages =
      pages.filter(
        (
          page,
        ): page is PdfPageText =>
          page !==
          undefined,
      );

    const extractedCharacterCount =
      orderedPages.reduce(
        (
          total,
          page,
        ) =>
          total +
          page.text.length,
        0,
      );

    if (
      extractedCharacterCount <
      20
    ) {
      throw new PdfNoTextError(
        fileName,
      );
    }

    return {
      title,

      pageCount:
        document.numPages,

      pages:
        orderedPages,

      extractedCharacterCount,
    };
  } finally {
    await loadingTask
      .destroy()
      .catch(() => {
        /*
         * Cleanup failure should not hide
         * successfully extracted text.
         */
      });
  }
}

function extractPdfTitle(
  info: unknown,
): string | undefined {
  if (
    !info ||
    typeof info !==
    "object"
  ) {
    return undefined;
  }

  const record =
    info as Record<
      string,
      unknown
    >;

  const value =
    record.Title;

  if (
    typeof value !==
    "string"
  ) {
    return undefined;
  }

  const trimmed =
    value.trim();

  return trimmed.length > 0
    ? trimmed
    : undefined;
}

function reconstructLines(
  rawItems: unknown[],
): string[] {
  const lines:
    string[] = [];

  let line = "";

  let previousY:
    | number
    | null = null;

  const flush =
    (): void => {
      const normalized =
        normalizeLine(line);

      if (normalized) {
        lines.push(
          normalized,
        );
      }

      line = "";
    };

  for (
    const raw of
    rawItems
  ) {
    if (
      !isPdfTextItem(raw)
    ) {
      continue;
    }

    const text =
      raw.str.replace(
        /\s+/g,
        " ",
      );

    const y =
      extractY(raw);

    if (
      previousY !== null &&
      y !== null &&
      Math.abs(
        y - previousY,
      ) > 2.5 &&
      line.trim().length >
        0
    ) {
      flush();
    }

    if (
      text.length > 0
    ) {
      if (
        line.length > 0 &&
        needsSpace(
          line,
          text,
        )
      ) {
        line += " ";
      }

      line += text;
    }

    if (raw.hasEOL) {
      flush();
    }

    if (y !== null) {
      previousY = y;
    }
  }

  flush();

  return lines;
}

function isPdfTextItem(
  value: unknown,
): value is PdfTextItem {
  if (
    !value ||
    typeof value !==
    "object"
  ) {
    return false;
  }

  const candidate =
    value as
      Partial<
        PdfTextItem
      >;

  return (
    typeof candidate.str ===
    "string"
  );
}

function extractY(
  item: PdfTextItem,
): number | null {
  const transform =
    item.transform;

  if (
    !transform ||
    transform.length < 6
  ) {
    return null;
  }

  const value =
    transform[5];

  return typeof value ===
    "number"
    ? value
    : null;
}

function normalizeLine(
  value: string,
): string {
  return value
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function needsSpace(
  current: string,
  next: string,
): boolean {
  if (
    current.endsWith("-")
  ) {
    return false;
  }

  if (
    /^[,.;:!?%)\]}]/.test(
      next,
    )
  ) {
    return false;
  }

  if (
    /[(\[{]$/.test(
      current,
    )
  ) {
    return false;
  }

  return true;
}
