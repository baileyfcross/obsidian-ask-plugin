import {
  App,
  DataAdapter,
  normalizePath,
} from "obsidian";

export interface PluginPaths {
  pluginDir: string;
  dataDir: string;
  indexPath: string;
  manifestPath: string;
  conversationsDir: string;
  conversationsIndexPath: string;
  localEmbeddingsDir: string;
}

export function getPluginPaths(
  app: App,
  pluginId: string,
): PluginPaths {
  const pluginDir = normalizePath(
    `${app.vault.configDir}/plugins/${pluginId}`,
  );

  const dataDir = normalizePath(
    `${pluginDir}/data`,
  );

  const conversationsDir = normalizePath(
    `${dataDir}/conversations`,
  );

  const localEmbeddingsDir = normalizePath(
    `${dataDir}/local-embeddings`,
  );

  return {
    pluginDir,
    dataDir,
    indexPath: normalizePath(
      `${dataDir}/knowledge-index.json`,
    ),
    manifestPath: normalizePath(
      `${dataDir}/index-manifest.json`,
    ),
    conversationsDir,
    conversationsIndexPath: normalizePath(
      `${conversationsDir}/index.json`,
    ),
    localEmbeddingsDir,
  };
}

export async function ensurePluginPaths(
  app: App,
  paths: PluginPaths,
): Promise<void> {
  const adapter = app.vault.adapter;

  await ensureDirectory(
    adapter,
    paths.dataDir,
  );

  await ensureDirectory(
    adapter,
    paths.conversationsDir,
  );

  await ensureDirectory(
    adapter,
    paths.localEmbeddingsDir,
  );
}

async function ensureDirectory(
  adapter: DataAdapter,
  path: string,
): Promise<void> {
  if (await adapter.exists(path)) {
    return;
  }

  await adapter.mkdir(path);
}
