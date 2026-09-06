# Local Vault AI — Phase 2

This Phase 2 build turns the original proof of concept into a persistent, incremental, hybrid-search Obsidian plugin.

## Features

- Ollama connection health checks
- Configurable chat and embedding models
- Markdown heading-aware chunking
- SHA-256 document hashing
- Incremental create/modify/rename/delete indexing
- Obsidian tags, links, and frontmatter properties in retrieval
- Orama full-text + vector hybrid search
- Binary search-index persistence
- Separate index manifest
- Persistent local conversation history
- Vault Only and Vault + Model modes
- Clickable source notes
- Clear index status UI

## Prerequisites

Install and run Ollama.

Recommended starting models:

```powershell
ollama pull qwen3:8b
ollama pull embeddinggemma
```

Verify:

```powershell
ollama list
Invoke-WebRequest http://localhost:11434
```

## Installation over the Phase 1 plugin

Your plugin folder should be:

```text
<Vault>/.obsidian/plugins/local-vault-ai/
```

1. Stop `npm run dev` if it is currently running.
2. Back up your existing plugin folder.
3. Replace the Phase 1 source/config files with the files from this Phase 2 package.
4. There should no longer be a root-level `main.ts`. Phase 2 uses `src/main.ts`.
5. Run:

```powershell
npm install
npm run typecheck
npm run dev
```

6. In Obsidian, reload the plugin or restart Obsidian.
7. Open **Settings → Local Vault AI**.
8. Click **Test connection**.
9. Confirm the chat model and embedding model names.
10. Click **Rebuild index** once.

After the first successful build, the create/modify/rename/delete listeners maintain the index automatically when **Automatic indexing** is enabled.

## Generated local data

The plugin creates:

```text
.obsidian/plugins/local-vault-ai/data/
├── knowledge-index.msp
├── index-manifest.json
└── conversations/
    ├── index.json
    └── <conversation-id>.json
```

These are derived local data. Your Markdown notes are never modified by this plugin.

## If rebuild says Ollama is offline

Run:

```powershell
ollama list
```

If that fails, start Ollama or run:

```powershell
ollama serve
```

Then test:

```powershell
Invoke-WebRequest http://localhost:11434
```

The plugin default URL is:

```text
http://localhost:11434
```

## If the embedding model is missing

Run:

```powershell
ollama pull embeddinggemma
```

If you choose a different embedding model in settings, pull that exact model and rebuild the index.

## Important embedding-model rule

You may switch chat models without rebuilding.

If you switch embedding models, you must rebuild the full knowledge index because embeddings produced by different models must not be mixed.

## Development validation

Before using on a primary vault, validate in a test vault:

1. Rebuild index.
2. Restart Obsidian and verify the index restores without rebuilding.
3. Ask a question that should retrieve a known note.
4. Edit that note.
5. Wait roughly 2–4 seconds.
6. Ask again and verify the updated content is used.
7. Rename the note and verify retrieval still works.
8. Delete a test note and verify it disappears from retrieval.
9. Stop Ollama and verify the plugin shows a clear offline error.
10. Restart Ollama and verify queries work again.

## Phase 2 boundary

This version intentionally does not write to notes and does not use the internet.

A later phase can add:

- streamed Ollama responses
- retrieval-debug scoring UI
- graph expansion over resolved wikilinks/backlinks
- reranking
- PDF/EPUB attachment indexing
- note-writing actions with explicit confirmation
