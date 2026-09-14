import {
  DataAdapter,
} from "obsidian";
import {
  EmbeddingDescriptor,
  EmbeddingProvider,
} from "../embeddings/EmbeddingService";
import {
  SourceType,
} from "../types";

export const INDEX_VERSION =
  7;

export interface IndexedDocument {
  hash: string;
  mtime: number;
  chunkIds: string[];

  sourceType:
    SourceType;

  fileName: string;
  title: string;
  pageCount?: number;
}

export interface IndexManifest {
  version: number;

  embeddingProvider:
    EmbeddingProvider;

  embeddingIdentity:
    string;

  embeddingDimensions:
    number;

  lastIndexedAt:
    string;

  documents:
    Record<
      string,
      IndexedDocument
    >;
}

export function createEmptyManifest(
  descriptor:
    EmbeddingDescriptor,
  embeddingDimensions:
    number,
): IndexManifest {
  return {
    version:
      INDEX_VERSION,

    embeddingProvider:
      descriptor.provider,

    embeddingIdentity:
      descriptor.identity,

    embeddingDimensions,

    lastIndexedAt:
      new Date()
        .toISOString(),

    documents: {},
  };
}

export async function loadManifest(
  adapter:
    DataAdapter,
  path:
    string,
): Promise<IndexManifest | null> {
  if (
    !(await adapter.exists(
      path,
    ))
  ) {
    return null;
  }

  const raw =
    await adapter.read(
      path,
    );

  return JSON.parse(
    raw,
  ) as
    IndexManifest;
}

export async function saveManifest(
  adapter:
    DataAdapter,
  path:
    string,
  manifest:
    IndexManifest,
): Promise<void> {
  manifest.lastIndexedAt =
    new Date()
      .toISOString();

  await adapter.write(
    path,
    JSON.stringify(
      manifest,
      null,
      2,
    ),
  );
}
