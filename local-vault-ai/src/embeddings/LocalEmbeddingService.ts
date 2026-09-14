import {
  DataAdapter,
  normalizePath,
  requestUrl,
} from "obsidian";
import {
  Tokenizer,
} from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web/wasm";
import {
  EmbeddingDescriptor,
  EmbeddingService,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_IDENTITY,
  LOCAL_EMBEDDING_MAX_TOKENS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODEL_FILE,
} from "./EmbeddingService";

const ORT_VERSION =
  "1.29.0";

const MODEL_BASE_URL =
  `https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/main`;

const TOKENIZER_URL =
  `${MODEL_BASE_URL}/tokenizer.json?download=true`;

const TOKENIZER_CONFIG_URL =
  `${MODEL_BASE_URL}/tokenizer_config.json?download=true`;

const MODEL_URL =
  `${MODEL_BASE_URL}/${LOCAL_EMBEDDING_MODEL_FILE}?download=true`;

/*
 * We intentionally use the plain WASM backend and provide
 * the WASM binary ourselves. This avoids worker/CSP/path
 * problems inside Obsidian/Electron and keeps the runtime
 * version exactly matched to the installed npm package.
 */
const ORT_MJS_URL =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.mjs`;

const ORT_WASM_URL =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`;

const TOKENIZER_FILE =
  "tokenizer.json";

const TOKENIZER_CONFIG_FILE =
  "tokenizer_config.json";

const MODEL_FILE =
  "model_quantized.onnx";

const ORT_MJS_FILE =
  `ort-wasm-simd-threaded-${ORT_VERSION}.mjs`;

const ORT_WASM_FILE =
  `ort-wasm-simd-threaded-${ORT_VERSION}.wasm`;

const MODEL_CACHE_VERSION =
  "minilm-l6-v2-quantized-v1";

const PAD_TOKEN_ID =
  0;

interface EncodedText {
  ids: number[];
  attention_mask?: number[];
  type_ids?: number[];
  token_type_ids?: number[];
}

interface PreparedBatch {
  batchSize: number;
  sequenceLength: number;
  attentionMask:
    BigInt64Array;
  inputIds:
    BigInt64Array;
  tokenTypeIds:
    BigInt64Array;
  realTokenCounts:
    number[];
}

interface LocalRuntime {
  tokenizer:
    Tokenizer;

  session:
    ort.InferenceSession;
}

/*
 * Keep one local inference call active at a time.
 * Each call may contain a full document batch.
 * This avoids concurrent access to one ONNX session while
 * still benefiting from batching and the surrounding PDF/
 * source parallelism.
 */
let localInferenceChain:
  Promise<void> =
  Promise.resolve();

export class LocalEmbeddingService
  implements
    EmbeddingService {
  private runtime:
    LocalRuntime | null =
    null;

  private runtimePromise:
    Promise<LocalRuntime> |
    null = null;

  private readonly modelCacheDir:
    string;

  private readonly runtimeCacheDir:
    string;

  constructor(
    private readonly adapter:
      DataAdapter,

    localCacheDir:
      string,
  ) {
    this.modelCacheDir =
      normalizePath(
        `${localCacheDir}/${MODEL_CACHE_VERSION}`,
      );

    this.runtimeCacheDir =
      normalizePath(
        `${localCacheDir}/onnxruntime-web-${ORT_VERSION}`,
      );
  }

  getDescriptor():
    EmbeddingDescriptor {
    return {
      provider:
        "local",

      identity:
        `local:${LOCAL_EMBEDDING_IDENTITY}`,

      displayName:
        `Local — ${LOCAL_EMBEDDING_MODEL} (quantized ONNX)`,
    };
  }

  async validate():
    Promise<void> {
    await this.getRuntime();
  }

  async embeddingDimension():
    Promise<number> {
    /*
     * This model is fixed and has a 384-dimensional
     * sentence-embedding space.
     */
    return LOCAL_EMBEDDING_DIMENSIONS;
  }

  async embed(
    input: string[],
  ): Promise<number[][]> {
    if (
      input.length === 0
    ) {
      return [];
    }

    return this.runExclusive(
      async () => {
        const runtime =
          await this.getRuntime();

        const batch =
          this.prepareBatch(
            runtime.tokenizer,
            input,
          );

        const feeds:
          Record<
            string,
            ort.Tensor
          > = {};

        if (
          runtime.session
            .inputNames
            .includes(
              "input_ids",
            )
        ) {
          feeds.input_ids =
            new ort.Tensor(
              "int64",
              batch.inputIds,
              [
                batch.batchSize,
                batch.sequenceLength,
              ],
            );
        }

        if (
          runtime.session
            .inputNames
            .includes(
              "attention_mask",
            )
        ) {
          feeds.attention_mask =
            new ort.Tensor(
              "int64",
              batch.attentionMask,
              [
                batch.batchSize,
                batch.sequenceLength,
              ],
            );
        }

        if (
          runtime.session
            .inputNames
            .includes(
              "token_type_ids",
            )
        ) {
          feeds.token_type_ids =
            new ort.Tensor(
              "int64",
              batch.tokenTypeIds,
              [
                batch.batchSize,
                batch.sequenceLength,
              ],
            );
        }

        const missingInputs =
          runtime.session
            .inputNames
            .filter(
              (name) =>
                !(name in feeds),
            );

        if (
          missingInputs.length > 0
        ) {
          throw new Error(
            `The local ONNX model requires unsupported input(s): ${missingInputs.join(", ")}.`,
          );
        }

        const outputs =
          await runtime.session
            .run(feeds);

        const hidden =
          this.findHiddenState(
            outputs,
          );

        return this.meanPoolAndNormalize(
          hidden,
          batch,
        );
      },
    );
  }

  private async getRuntime():
    Promise<LocalRuntime> {
    if (this.runtime) {
      return this.runtime;
    }

    if (
      this.runtimePromise
    ) {
      return this.runtimePromise;
    }

    this.runtimePromise =
      this.loadRuntime();

    try {
      this.runtime =
        await this.runtimePromise;

      return this.runtime;
    } catch (error) {
      /*
       * Permit an intentional retry after a temporary
       * network/download/runtime failure.
       */
      this.runtimePromise =
        null;

      throw error;
    }
  }

  private async loadRuntime():
    Promise<LocalRuntime> {
    try {
      await this.ensureDirectory(
        this.modelCacheDir,
      );

      await this.ensureDirectory(
        this.runtimeCacheDir,
      );

      const ortMjsPath =
        normalizePath(
          `${this.runtimeCacheDir}/${ORT_MJS_FILE}`,
        );

      const ortWasmPath =
        normalizePath(
          `${this.runtimeCacheDir}/${ORT_WASM_FILE}`,
        );

      const [
        tokenizerJson,
        tokenizerConfig,
        modelBytes,
      ] = await Promise.all([
        this.loadJsonAsset(
          normalizePath(
            `${this.modelCacheDir}/${TOKENIZER_FILE}`,
          ),
          TOKENIZER_URL,
          "tokenizer",
        ),

        this.loadJsonAsset(
          normalizePath(
            `${this.modelCacheDir}/${TOKENIZER_CONFIG_FILE}`,
          ),
          TOKENIZER_CONFIG_URL,
          "tokenizer configuration",
        ),

        this.loadBinaryAsset(
          normalizePath(
            `${this.modelCacheDir}/${MODEL_FILE}`,
          ),
          MODEL_URL,
          "quantized embedding model",
        ),

        this.ensureTextAsset(
          ortMjsPath,
          ORT_MJS_URL,
          "ONNX Runtime JavaScript loader",
        ),

        this.ensureBinaryAsset(
          ortWasmPath,
          ORT_WASM_URL,
          "ONNX Runtime WebAssembly runtime",
        ),
      ]);

      const tokenizer =
        new Tokenizer(
          tokenizerJson,
          tokenizerConfig,
        );

      /*
       * ONNX Runtime Web's external-WASM build requires
       * TWO matching runtime assets:
       *
       *   ort-wasm-simd-threaded.mjs
       *   ort-wasm-simd-threaded.wasm
       *
       * Without an explicit mjs path ORT tries to resolve
       * the loader relative to Obsidian itself, producing:
       *
       *   app://obsidian.md/ort-wasm-simd-threaded.mjs
       *
       * DataAdapter.getResourcePath() converts the files we
       * cached inside the vault/plugin data directory into
       * browser-loadable Obsidian resource URLs.
       *
       * The .mjs and .wasm files are downloaded from the
       * exact same ORT_VERSION as the installed JS package.
       */
      const ortMjsResource =
        this.adapter
          .getResourcePath(
            ortMjsPath,
          );

      const ortWasmResource =
        this.adapter
          .getResourcePath(
            ortWasmPath,
          );

      ort.env.wasm.numThreads =
        1;

      ort.env.wasm.proxy =
        false;

      /*
       * Clear an old in-memory binary override if this
       * plugin instance previously attempted the older
       * wasmBinary-only configuration.
       */
      ort.env.wasm.wasmBinary =
        undefined;

      ort.env.wasm.wasmPaths = {
        mjs:
          ortMjsResource,

        wasm:
          ortWasmResource,
      };

      const session =
        await ort.InferenceSession
          .create(
            modelBytes,
            {
              executionProviders: [
                "wasm",
              ],

              graphOptimizationLevel:
                "all",
            },
          );

      console.info(
        `[Local Vault AI] Local embedding backend ready: ${LOCAL_EMBEDDING_MODEL}.`,
      );

      return {
        tokenizer,
        session,
      };
    } catch (error) {
      throw new Error(
        "Could not initialize the local embedding backend. " +
          "Local mode uses @huggingface/tokenizers plus onnxruntime-web directly; " +
          "it does not use the Transformers.js package or a local Ollama server. " +
          "On first use, model/runtime assets are downloaded into the plugin data directory and reused locally. " +
          this.errorText(error),
      );
    }
  }

  private prepareBatch(
    tokenizer:
      Tokenizer,
    input:
      string[],
  ): PreparedBatch {
    const encodedRows =
      input.map(
        (text) =>
          this.encodeText(
            tokenizer,
            text,
          ),
      );

    const sequenceLength =
      Math.max(
        1,
        ...encodedRows.map(
          (row) =>
            row.ids.length,
        ),
      );

    const batchSize =
      encodedRows.length;

    const elementCount =
      batchSize *
      sequenceLength;

    const inputIds =
      new BigInt64Array(
        elementCount,
      );

    inputIds.fill(
      BigInt(
        PAD_TOKEN_ID,
      ),
    );

    const attentionMask =
      new BigInt64Array(
        elementCount,
      );

    const tokenTypeIds =
      new BigInt64Array(
        elementCount,
      );

    const realTokenCounts:
      number[] = [];

    for (
      let batchIndex = 0;
      batchIndex <
      encodedRows.length;
      batchIndex += 1
    ) {
      const row =
        encodedRows[
          batchIndex
        ];

      if (!row) {
        continue;
      }

      const rowOffset =
        batchIndex *
        sequenceLength;

      let realTokens =
        0;

      for (
        let tokenIndex = 0;
        tokenIndex <
        row.ids.length;
        tokenIndex += 1
      ) {
        const position =
          rowOffset +
          tokenIndex;

        const id =
          row.ids[
            tokenIndex
          ] ??
          PAD_TOKEN_ID;

        const mask =
          row.attentionMask[
            tokenIndex
          ] ??
          1;

        const typeId =
          row.typeIds[
            tokenIndex
          ] ??
          0;

        inputIds[
          position
        ] = BigInt(id);

        attentionMask[
          position
        ] = BigInt(
          mask,
        );

        tokenTypeIds[
          position
        ] = BigInt(
          typeId,
        );

        if (
          mask !== 0
        ) {
          realTokens += 1;
        }
      }

      realTokenCounts.push(
        Math.max(
          1,
          realTokens,
        ),
      );
    }

    return {
      batchSize,
      sequenceLength,
      inputIds,
      attentionMask,
      tokenTypeIds,
      realTokenCounts,
    };
  }

  private encodeText(
    tokenizer:
      Tokenizer,
    text:
      string,
  ): {
    ids: number[];
    attentionMask: number[];
    typeIds: number[];
  } {
    const encoded =
      tokenizer.encode(
        text,
      ) as EncodedText;

    let ids =
      Array.from(
        encoded.ids ??
        [],
      );

    let attentionMask =
      Array.from(
        encoded.attention_mask ??
        new Array(
          ids.length,
        ).fill(1),
      );

    let typeIds =
      Array.from(
        encoded.type_ids ??
        encoded.token_type_ids ??
        new Array(
          ids.length,
        ).fill(0),
      );

    if (
      ids.length === 0
    ) {
      throw new Error(
        "The local tokenizer returned no tokens.",
      );
    }

    if (
      ids.length >
      LOCAL_EMBEDDING_MAX_TOKENS
    ) {
      /*
       * BERT-style tokenizers put [SEP] at the end.
       * Preserve that final special token while clipping
       * the middle of overly long source chunks.
       */
      const finalId =
        ids[
          ids.length - 1
        ];

      const finalTypeId =
        typeIds[
          typeIds.length - 1
        ] ??
        0;

      ids = [
        ...ids.slice(
          0,
          LOCAL_EMBEDDING_MAX_TOKENS -
            1,
        ),
        finalId ??
          PAD_TOKEN_ID,
      ];

      attentionMask =
        new Array(
          ids.length,
        ).fill(1);

      typeIds = [
        ...typeIds.slice(
          0,
          LOCAL_EMBEDDING_MAX_TOKENS -
            1,
        ),
        finalTypeId,
      ];
    }

    if (
      attentionMask.length !==
      ids.length
    ) {
      attentionMask =
        new Array(
          ids.length,
        ).fill(1);
    }

    if (
      typeIds.length !==
      ids.length
    ) {
      typeIds =
        new Array(
          ids.length,
        ).fill(0);
    }

    return {
      ids,
      attentionMask,
      typeIds,
    };
  }

  private findHiddenState(
    outputs:
      Record<string, unknown>,
  ): ort.Tensor {
    const named =
      outputs[
        "last_hidden_state"
      ];

    if (
      named instanceof
      ort.Tensor
    ) {
      return named;
    }

    for (
      const value of
      Object.values(
        outputs,
      )
    ) {
      if (
        value instanceof
          ort.Tensor &&
        value.dims.length ===
          3
      ) {
        return value;
      }
    }

    throw new Error(
      "The local embedding model did not return a 3-D token hidden-state tensor.",
    );
  }

  private meanPoolAndNormalize(
    hidden:
      ort.Tensor,
    batch:
      PreparedBatch,
  ): number[][] {
    if (
      hidden.dims.length !==
      3
    ) {
      throw new Error(
        `Unexpected hidden-state rank: ${hidden.dims.length}.`,
      );
    }

    const outputBatch =
      Number(
        hidden.dims[0],
      );

    const outputSequence =
      Number(
        hidden.dims[1],
      );

    const hiddenSize =
      Number(
        hidden.dims[2],
      );

    if (
      outputBatch !==
      batch.batchSize ||
      outputSequence !==
      batch.sequenceLength
    ) {
      throw new Error(
        "The local embedding model returned an unexpected output shape.",
      );
    }

    if (
      hiddenSize !==
      LOCAL_EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `Local embedding dimension mismatch. Expected ${LOCAL_EMBEDDING_DIMENSIONS}, got ${hiddenSize}.`,
      );
    }

    const data =
      hidden.data as unknown as
        ArrayLike<number>;

    const vectors:
      number[][] = [];

    for (
      let batchIndex = 0;
      batchIndex <
      batch.batchSize;
      batchIndex += 1
    ) {
      const vector =
        new Float64Array(
          hiddenSize,
        );

      let denominator =
        0;

      for (
        let tokenIndex = 0;
        tokenIndex <
        batch.sequenceLength;
        tokenIndex += 1
      ) {
        const maskIndex =
          batchIndex *
            batch.sequenceLength +
          tokenIndex;

        const mask =
          Number(
            batch.attentionMask[
              maskIndex
            ] ??
            0n,
          );

        if (
          mask === 0
        ) {
          continue;
        }

        denominator +=
          mask;

        const hiddenOffset =
          (
            batchIndex *
              batch.sequenceLength +
            tokenIndex
          ) *
          hiddenSize;

        for (
          let dimension = 0;
          dimension <
          hiddenSize;
          dimension += 1
        ) {
          const current =
            vector[
              dimension
            ] ?? 0;

          vector[
            dimension
          ] =
            current +
            Number(
              data[
                hiddenOffset +
                dimension
              ] ??
              0,
            ) *
            mask;
        }
      }

      denominator =
        Math.max(
          denominator,
          1e-9,
        );

      let normSquared =
        0;

      for (
        let dimension = 0;
        dimension <
        hiddenSize;
        dimension += 1
      ) {
        const averaged =
          (
            vector[
              dimension
            ] ?? 0
          ) /
          denominator;

        vector[
          dimension
        ] =
          averaged;

        normSquared +=
          averaged *
          averaged;
      }

      const norm =
        Math.sqrt(
          Math.max(
            normSquared,
            1e-12,
          ),
        );

      vectors.push(
        Array.from(
          vector,
          (value) =>
            value /
            norm,
        ),
      );
    }

    return vectors;
  }

  private async loadJsonAsset(
    path:
      string,
    url:
      string,
    label:
      string,
  ): Promise<
    Record<
      string,
      unknown
    >
  > {
    if (
      await this.adapter
        .exists(path)
    ) {
      const cached =
        await this.adapter
          .read(path);

      return this.parseJson(
        cached,
        label,
      );
    }

    console.info(
      `[Local Vault AI] Downloading local embedding ${label}...`,
    );

    const response =
      await requestUrl({
        url,
        method:
          "GET",
        throw:
          false,
      });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(
        `Could not download ${label}: HTTP ${response.status}.`,
      );
    }

    const text =
      response.text;

    const parsed =
      this.parseJson(
        text,
        label,
      );

    await this.adapter
      .write(
        path,
        text,
      );

    return parsed;
  }

  private async ensureTextAsset(
    path:
      string,
    url:
      string,
    label:
      string,
  ): Promise<void> {
    if (
      await this.adapter
        .exists(path)
    ) {
      const cached =
        await this.adapter
          .read(path);

      if (
        cached.trim()
          .length > 0
      ) {
        return;
      }
    }

    console.info(
      `[Local Vault AI] Downloading local embedding ${label}...`,
    );

    const response =
      await requestUrl({
        url,
        method:
          "GET",
        throw:
          false,
      });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(
        `Could not download ${label}: HTTP ${response.status}.`,
      );
    }

    if (
      response.text.trim()
        .length === 0
    ) {
      throw new Error(
        `Downloaded ${label} was empty.`,
      );
    }

    await this.adapter
      .write(
        path,
        response.text,
      );
  }

  private async ensureBinaryAsset(
    path:
      string,
    url:
      string,
    label:
      string,
  ): Promise<void> {
    if (
      await this.adapter
        .exists(path)
    ) {
      const cached =
        await this.adapter
          .readBinary(path);

      if (
        cached.byteLength > 0
      ) {
        return;
      }
    }

    console.info(
      `[Local Vault AI] Downloading local embedding ${label}...`,
    );

    const response =
      await requestUrl({
        url,
        method:
          "GET",
        throw:
          false,
      });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(
        `Could not download ${label}: HTTP ${response.status}.`,
      );
    }

    if (
      response.arrayBuffer
        .byteLength === 0
    ) {
      throw new Error(
        `Downloaded ${label} was empty.`,
      );
    }

    await this.adapter
      .writeBinary(
        path,
        response.arrayBuffer,
      );
  }

  private async loadBinaryAsset(
    path:
      string,
    url:
      string,
    label:
      string,
  ): Promise<Uint8Array> {
    if (
      await this.adapter
        .exists(path)
    ) {
      const cached =
        await this.adapter
          .readBinary(path);

      if (
        cached.byteLength > 0
      ) {
        return new Uint8Array(
          cached,
        );
      }
    }

    console.info(
      `[Local Vault AI] Downloading local embedding ${label}...`,
    );

    const response =
      await requestUrl({
        url,
        method:
          "GET",
        throw:
          false,
      });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(
        `Could not download ${label}: HTTP ${response.status}.`,
      );
    }

    const buffer =
      response.arrayBuffer;

    if (
      buffer.byteLength === 0
    ) {
      throw new Error(
        `Downloaded ${label} was empty.`,
      );
    }

    await this.adapter
      .writeBinary(
        path,
        buffer,
      );

    return new Uint8Array(
      buffer,
    );
  }

  private parseJson(
    text:
      string,
    label:
      string,
  ): Record<
    string,
    unknown
  > {
    try {
      const parsed =
        JSON.parse(
          text,
        ) as unknown;

      if (
        !parsed ||
        typeof parsed !==
          "object" ||
        Array.isArray(
          parsed,
        )
      ) {
        throw new Error(
          "Expected an object.",
        );
      }

      return parsed as
        Record<
          string,
          unknown
        >;
    } catch (error) {
      throw new Error(
        `Cached/downloaded ${label} is not valid JSON. ${this.errorText(error)}`,
      );
    }
  }

  private async ensureDirectory(
    path:
      string,
  ): Promise<void> {
    if (
      await this.adapter
        .exists(path)
    ) {
      return;
    }

    await this.adapter
      .mkdir(path);
  }

  private async runExclusive<T>(
    task:
      () => Promise<T>,
  ): Promise<T> {
    let release:
      () => void =
      () => {};

    const previous =
      localInferenceChain;

    localInferenceChain =
      new Promise<void>(
        (resolve) => {
          release =
            resolve;
        },
      );

    await previous;

    try {
      return await task();
    } finally {
      release();
    }
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

    return String(error);
  }
}
