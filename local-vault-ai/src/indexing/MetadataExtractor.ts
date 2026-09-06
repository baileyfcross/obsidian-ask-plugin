import {
  App,
  CachedMetadata,
  getAllTags,
  TFile,
} from "obsidian";

export interface NoteMetadata {
  tags: string[];
  links: string[];
  properties: string[];
}

export function extractMetadata(
  app: App,
  file: TFile,
): NoteMetadata {
  const cache = app.metadataCache.getFileCache(file);

  if (!cache) {
    return {
      tags: [],
      links: [],
      properties: [],
    };
  }

  const tags = Array.from(
    new Set(
      (getAllTags(cache) ?? []).map((tag) =>
        tag.replace(/^#/, ""),
      ),
    ),
  );

  const links = extractLinks(cache);
  const properties = extractProperties(cache);

  return {
    tags,
    links,
    properties,
  };
}

function extractLinks(cache: CachedMetadata): string[] {
  const values: string[] = [];

  for (const link of cache.links ?? []) {
    values.push(link.link);
  }

  for (const embed of cache.embeds ?? []) {
    values.push(embed.link);
  }

  for (const link of cache.frontmatterLinks ?? []) {
    values.push(link.link);
  }

  return Array.from(new Set(values));
}

function extractProperties(
  cache: CachedMetadata,
): string[] {
  if (!cache.frontmatter) {
    return [];
  }

  const results: string[] = [];

  for (const [key, value] of Object.entries(
    cache.frontmatter,
  )) {
    if (key === "position") {
      continue;
    }

    flattenProperty(key, value, results);
  }

  return results;
}

function flattenProperty(
  key: string,
  value: unknown,
  results: string[],
): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenProperty(key, item, results);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      flattenProperty(
        `${key}.${childKey}`,
        childValue,
        results,
      );
    }
    return;
  }

  results.push(`${key}=${String(value)}`);
}
