import {
  DataAdapter,
} from "obsidian";

export const INDEX_VERSION = 3;

export interface IndexedDocument {
  hash: string;
  mtime: number;
  chunkIds: string[];
}

export interface IndexManifest {
  version: number;
  embeddingModel: string;
  embeddingDimensions: number;
  lastIndexedAt: string;
  documents: Record<string, IndexedDocument>;
}

export function createEmptyManifest(
  embeddingModel: string,
  embeddingDimensions: number,
): IndexManifest {
  return {
    version: INDEX_VERSION,
    embeddingModel,
    embeddingDimensions,
    lastIndexedAt:
      new Date().toISOString(),
    documents: {},
  };
}

export async function loadManifest(
  adapter: DataAdapter,
  path: string,
): Promise<IndexManifest | null> {
  if (!(await adapter.exists(path))) {
    return null;
  }

  const raw =
    await adapter.read(path);

  return JSON.parse(raw) as IndexManifest;
}

export async function saveManifest(
  adapter: DataAdapter,
  path: string,
  manifest: IndexManifest,
): Promise<void> {
  manifest.lastIndexedAt =
    new Date().toISOString();

  await adapter.write(
    path,
    JSON.stringify(
      manifest,
      null,
      2,
    ),
  );
}
