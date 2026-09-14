# Local Vault AI

Local Vault AI is an Obsidian desktop plugin that provides private retrieval-augmented generation over a local Obsidian vault.

The plugin indexes Markdown notes and PDFs, stores the searchable knowledge index locally, retrieves relevant chunks with hybrid lexical and vector search, and sends only the selected context to a configured Ollama server for answer generation.

The project is designed around a simple principle:

```text
Your vault remains the source of truth.
```

Indexing, chunking, metadata extraction, retrieval, section matching, source resolution, conversation storage, and citation handling all happen locally inside the Obsidian plugin.

Generative model requests are sent to the Ollama server configured in the plugin settings.

Local embeddings can be enabled so document and query embeddings are generated directly inside Obsidian without using Ollama for embeddings.

---

## Project Goals

The main goals of Local Vault AI are:

- Search an Obsidian vault conversationally.
- Index both Markdown and PDF files.
- Preserve source metadata such as file path, PDF page, section number, and heading.
- Support direct questions about specific books or numbered sections.
- Keep retrieval and storage local.
- Allow embeddings to run locally inside Obsidian.
- Allow Ollama to remain on a separate LAN server.
- Stream model reasoning and final answers into the chat interface.
- Persist chat conversations between Obsidian sessions.
- Provide citations that open the original source at the referenced location.
- Avoid requiring a local Ollama installation on the Obsidian machine.

---

# Architecture

The current high-level architecture is:

```text
Obsidian Desktop
│
├── Vault
│   ├── Markdown notes
│   └── PDF source material
│
├── Local Vault AI Plugin
│   ├── Chat UI
│   ├── Conversation persistence
│   ├── Markdown extraction
│   ├── PDF.js extraction
│   ├── Section detection
│   ├── Chunking
│   ├── Source resolution
│   ├── Local or Ollama embeddings
│   ├── Orama knowledge index
│   ├── Hybrid retrieval
│   ├── Citation rendering
│   ├── Source navigation
│   └── Ollama model runtime integration
│
└── Configured Ollama Server
    ├── General chat model
    ├── Lecture model
    └── Optional embedding model
```

The Ollama server can run on the same computer or on another machine on the local network.

A typical configuration is:

```text
Obsidian workstation
        ↓
http://192.168.x.x:11434
        ↓
Ollama server
```

---

# Codebase Structure

The project is written in TypeScript and bundled into a single Obsidian plugin entry point with esbuild.

A typical source tree looks like this:

```text
local-vault-ai/
│
├── package.json
├── package-lock.json
├── tsconfig.json
├── esbuild.config.mjs
├── manifest.json
├── styles.css
│
├── scripts/
│   ├── package.sh
│   └── deploy-test.sh
│
└── src/
    ├── main.ts
    │
    ├── embeddings/
    │   ├── EmbeddingService.ts
    │   ├── EmbeddingServiceRouter.ts
    │   ├── LocalEmbeddingService.ts
    │   └── OllamaEmbeddingService.ts
    │
    ├── indexing/
    │   ├── Concurrency.ts
    │   ├── FileSystemGate.ts
    │   ├── IndexManager.ts
    │   ├── IndexManifest.ts
    │   ├── PdfChunker.ts
    │   └── PdfExtractor.ts
    │
    ├── ollama/
    │   ├── ModelRuntimeManager.ts
    │   └── OllamaClient.ts
    │
    ├── rag/
    │   └── RagService.ts
    │
    ├── retrieval/
    │   └── SourceResolver.ts
    │
    ├── search/
    │   └── KnowledgeIndex.ts
    │
    ├── settings/
    │   ├── Settings.ts
    │   └── SettingsTab.ts
    │
    ├── storage/
    │   ├── ConversationStore.ts
    │   └── PluginPaths.ts
    │
    ├── ui/
    │   ├── ChatView.ts
    │   └── SourceNavigator.ts
    │
    └── types.ts
```

The exact file list may change as features are added, but the responsibilities are intentionally separated by subsystem.

---

# Source Entry Point

## `src/main.ts`

`main.ts` is the Obsidian plugin entry point.

Its responsibilities include:

- Loading saved settings.
- Creating the Ollama client.
- Creating the embedding backend router.
- Creating the knowledge index.
- Creating the index manager.
- Creating the RAG service.
- Creating conversation storage.
- Registering the chat view.
- Registering settings.
- Wiring lifecycle events together.

The entry point should remain relatively small.

Most application logic should live in dedicated classes so indexing, retrieval, embeddings, and UI behavior remain independently maintainable.

---

# Embedding System

Local Vault AI supports two embedding modes.

## Local Embeddings

When:

```text
Use local embeddings = enabled
```

document embeddings and query embeddings are generated directly inside the Obsidian process.

The local pipeline is:

```text
text
↓
Hugging Face tokenizer
↓
token IDs + attention mask
↓
ONNX Runtime Web
↓
quantized sentence-transformer model
↓
mean pooling
↓
L2 normalization
↓
384-dimensional vector
```

The current local model is based on:

```text
Xenova/all-MiniLM-L6-v2
```

The local runtime caches the model, tokenizer files, and ONNX Runtime WebAssembly assets inside the plugin data directory.

This mode does not require a local Ollama server.

Only embedding generation is local. Chat and other generative requests still use the configured Ollama server.

## Ollama Embeddings

When:

```text
Use local embeddings = disabled
```

document and query embeddings are sent to the configured Ollama server through:

```text
/api/embed
```

The configured embedding model is typically:

```text
embeddinggemma
```

The same embedding backend must be used for both document indexing and query embeddings because vectors generated by unrelated models cannot safely be compared.

Changing embedding providers or embedding models therefore requires rebuilding the knowledge index.

---

# PDF Indexing

PDF support is built around PDF.js.

The PDF indexing pipeline is:

```text
PDF file
↓
read binary from Obsidian vault
↓
PDF.js
↓
extract page text
↓
reconstruct page order
↓
detect numbered sections
↓
split into chunks
↓
generate embeddings
↓
insert into Orama
```

Each PDF chunk can store metadata such as:

```text
filePath
fileName
sourceType
pageStart
pageEnd
sectionNumber
sectionTitle
sectionKey
sourceKey
sourceSearchName
```

This metadata is important because it allows retrieval to perform exact source and section lookups instead of relying entirely on semantic similarity.

For example:

```text
What does Foundations of Computation say in section 1.5?
```

can resolve to:

```text
sourceKey = FoundationsOfComputation_2.3.2.pdf
sectionKey = 1.5
```

rather than searching the entire vault for text related to `1.5`.

---

# Markdown Indexing

Markdown files are read directly through the Obsidian vault API.

The Markdown pipeline is:

```text
Markdown file
↓
read text
↓
identify headings / structure
↓
chunk text
↓
generate embeddings
↓
insert into Orama
```

Markdown citations retain enough metadata to reopen the original note.

When heading information is available, citations can jump directly to that heading.

---

# Source Resolution

Source resolution converts natural-language book or note references into indexed files.

For example:

```text
Foundations of Computing
```

can match:

```text
FoundationsOfComputation_2.3.2.pdf
```

The resolver normalizes:

- CamelCase.
- Underscores.
- Hyphens.
- File extensions.
- Common version suffixes.
- Related word forms.

The following word family is intentionally treated as equivalent for title matching:

```text
computer
computers
computing
computation
computational
```

This allows users to refer to sources naturally without memorizing exact filenames.

Explicit numbered-section requests fail closed.

If Local Vault AI cannot confidently resolve the requested source, it does not fall back to unrelated whole-vault retrieval.

This prevents situations where a request for a textbook section accidentally retrieves unrelated programming notes.

---

# Conversation Context

Follow-up questions can inherit a source from recent conversation context.

For example:

```text
User:
What does Foundations of Computation say in section 1.4?

User:
What about section 1.5?
```

The second question can reuse the previously resolved source.

Resolution order is approximately:

```text
1. Source named in the current question.
2. Source named in recent user messages.
3. A single unambiguous source cited by a recent assistant response.
```

The current question always takes priority.

---

# Retrieval

Retrieval uses Orama as the local search engine.

The main retrieval modes are:

```text
Hybrid whole-vault search
Source-restricted search
Exact source + section search
```

Hybrid retrieval combines:

- Text relevance.
- Vector similarity.

This allows direct keyword matches to remain useful while still benefiting from semantic similarity.

When a specific source and numbered section are requested, exact metadata filtering is preferred over semantic search.

---

# Citation Navigation

Assistant responses can include source buttons.

For PDF citations:

```text
FoundationsOfComputation_2.3.2.pdf · PDF p. 36
```

clicking the source opens:

```text
FoundationsOfComputation_2.3.2.pdf#page=36
```

inside Obsidian.

For Markdown:

```text
Lecture 2.md · Boolean Operators
```

the citation can open:

```text
Lecture 2.md#Boolean Operators
```

when heading metadata is available.

Modifier behavior is supported:

```text
Left click
→ open normally

Ctrl-click / Cmd-click
→ open in a new leaf or tab

Middle click
→ open in a new leaf or tab
```

---

# Conversation Storage

Conversations are stored separately from the knowledge index.

A typical plugin data directory is:

```text
.obsidian/plugins/local-vault-ai/data/
│
├── knowledge-index.json
├── index-manifest.json
├── conversations/
│   └── ...
│
└── local-embeddings/
    ├── model files
    ├── tokenizer files
    └── ONNX runtime files
```

Rebuilding the knowledge index should not delete saved conversations.

---

# Index Manifest

The index manifest records information required to determine whether an existing index is compatible with the current configuration.

Typical metadata includes:

```text
index version
embedding provider
embedding model identity
embedding dimensions
source modification state
```

If the embedding backend changes, the manifest prevents an incompatible index from being reused.

---

# Concurrency and Filesystem Safety

Indexing uses bounded concurrency.

The defaults are intentionally conservative:

```text
Concurrent source processing:      3
Concurrent filesystem operations:  2
Concurrent PDF page extraction:    6
Embedding batch size:              32
Remote embedding concurrency:      2
```

These values separate CPU work from filesystem I/O.

For example, multiple PDF sources can be processed at once while the number of simultaneous vault reads remains limited.

Filesystem operations also use retry and backoff handling for transient Obsidian or Electron filesystem timeouts.

Typical retry timing is:

```text
Attempt 1

wait 250 ms

Attempt 2

wait 750 ms

Attempt 3

wait 1500 ms

Attempt 4
```

For vaults stored on network drives, cloud-synced folders, or external storage, reducing filesystem concurrency to `1` can improve reliability.

---

# Ollama Integration

Ollama is used for generative model requests.

Typical models are:

```text
General chat:
gpt-oss:20b

Lecture generation:
qwen3:30b-instruct

Remote embeddings:
embeddinggemma
```

The configured Ollama URL may point to another computer on the LAN.

Example:

```text
http://192.168.1.164:11434
```

Local embedding mode does not change this behavior.

Even when embeddings are local:

```text
Question
↓
local query embedding
↓
local Orama retrieval
↓
selected context
↓
Ollama server
↓
generated answer
```

---

# Model Runtime Management

The plugin contains model runtime coordination so Local Vault AI can safely manage model requests and unload behavior.

The runtime manager tracks active jobs using leases.

Conceptually:

```text
job starts
↓
acquire model lease
↓
model stays available
↓
job finishes
↓
release lease
```

If a model unload is requested while a Local Vault AI job is active, the unload can be queued until the active lease is released.

This coordination only applies to work initiated by Local Vault AI.

It does not control unrelated Ollama clients.

---

# Development Requirements

The project assumes:

- Node.js
- npm
- Git Bash or another shell capable of running the project shell scripts
- Obsidian desktop
- An Ollama server for generative requests

A local Ollama installation on the Obsidian machine is not required when the server runs elsewhere on the LAN.

---

# Install Dependencies

From the project root:

```bash
npm install
```

This installs the dependencies listed in `package.json` and creates or updates `node_modules`.

For reproducible installs in CI or from an existing lock file:

```bash
npm ci
```

`npm ci` should be preferred when the exact dependency tree recorded in `package-lock.json` should be reproduced without modification.

---

# npm Commands

The exact scripts are defined in `package.json`.

The standard project scripts are:

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "typecheck": "tsc --noEmit",
    "package": "bash ./scripts/package.sh",
    "deploy:test": "bash ./scripts/deploy-test.sh"
  }
}
```

## `npm run dev`

Run:

```bash
npm run dev
```

This starts the esbuild development workflow.

The development build is intended for active coding and testing.

Depending on the current esbuild configuration, it may watch the source tree and rebuild `main.js` automatically when TypeScript files change.

Use this while actively editing the plugin.

Typical workflow:

```text
edit TypeScript
↓
esbuild rebuilds main.js
↓
reload plugin in Obsidian
↓
test changes
```

---

## `npm run build`

Run:

```bash
npm run build
```

This creates a production bundle.

Production mode is intended to create the final `main.js` used by the Obsidian plugin.

Use this before packaging or releasing the plugin.

The build process:

```text
TypeScript source
↓
esbuild
↓
bundle dependencies
↓
externalize Obsidian/Electron APIs
↓
main.js
```

---

## `npm run typecheck`

Run:

```bash
npm run typecheck
```

This runs:

```text
tsc --noEmit
```

TypeScript performs a full static type check but does not generate JavaScript output.

This should be run before packaging.

A normal development sequence is:

```bash
npm run typecheck
npm run build
```

The reason this is separate from esbuild is that esbuild is intentionally optimized for fast bundling and does not perform the same full TypeScript type analysis as `tsc`.

---

## `npm run package`

Run:

```bash
npm run package
```

This executes:

```text
scripts/package.sh
```

The packaging script is intended to create a distributable plugin package containing the files required by Obsidian.

The runtime plugin normally contains:

```text
main.js
manifest.json
styles.css
```

Downloaded local embedding assets are runtime cache data and are not normally distributed inside the plugin package.

The packaging step should generally be run after:

```bash
npm run typecheck
npm run build
```

---

## `npm run deploy:test`

Run:

```bash
npm run deploy:test
```

This executes:

```text
scripts/deploy-test.sh
```

The script is intended for local development deployment.

It copies the current plugin runtime files into a configured test vault, usually:

```text
<Vault>/.obsidian/plugins/local-vault-ai/
```

This allows the source repository to remain separate from the Obsidian runtime plugin directory.

A common development cycle is:

```bash
npm run typecheck
npm run build
npm run deploy:test
```

Then reload Local Vault AI inside Obsidian.

---

# Recommended Development Workflow

For a normal code change:

```bash
npm run typecheck
npm run build
npm run deploy:test
```

For active development:

```bash
npm run dev
```

Then reload the plugin as needed while testing.

Before creating a release:

```bash
npm ci
npm run typecheck
npm run build
npm run package
```

---

# Obsidian Runtime Directory

The source repository should remain outside the vault.

The runtime directory should contain only files needed by Obsidian:

```text
<Vault>/.obsidian/plugins/local-vault-ai/
│
├── main.js
├── manifest.json
├── styles.css
└── data/
```

Do not copy the entire TypeScript source tree into the runtime plugin directory.

Files such as:

```text
package.json
src/
esbuild.config.mjs
scripts/
node_modules/
```

belong in the development repository, not in the installed Obsidian plugin folder.

---

# Dependency Choices

The dependencies in this project are intentionally kept focused around Obsidian integration, local indexing, PDF extraction, embeddings, and bundling.

The following sections explain why each major dependency is used.

---

## Obsidian

Package:

```text
obsidian
```

Purpose:

The Obsidian package provides the TypeScript API definitions and plugin interfaces required to build an Obsidian desktop plugin.

It is used for:

- Plugin lifecycle hooks.
- Vault file access.
- Workspace navigation.
- Views.
- Settings.
- Notices.
- TFile handling.
- Internal link navigation.
- Resource paths.
- Events.

Why it is used:

The plugin should use Obsidian's official API rather than directly manipulating vault files or UI internals whenever possible.

The package is treated as an external dependency during bundling because Obsidian provides the runtime implementation itself.

---

## `@orama/orama`

Purpose:

Orama is the local search engine used to store and query the knowledge index.

It provides:

- Full-text search.
- Vector search.
- Metadata filtering.
- Hybrid retrieval.
- Serializable indexes.
- JavaScript-native operation.

Why it is used:

The project needs a search engine that can run directly inside the Obsidian desktop environment without requiring:

- PostgreSQL.
- Elasticsearch.
- SQLite extensions.
- A separate vector database.
- A server process.

Orama fits the plugin architecture because the entire search layer remains local and can be serialized into the plugin data directory.

It also supports exact metadata filters such as:

```text
sourceKey = ...
sectionKey = ...
```

which are critical for precise textbook section retrieval.

---

## `pdfjs-dist`

Purpose:

`pdfjs-dist` provides PDF.js for extracting text from PDF files.

It is used for:

- Opening PDF documents.
- Reading page content.
- Extracting text items.
- Preserving page boundaries.
- Building page-aware chunks.

Why it is used:

Obsidian can display PDFs, but the plugin needs access to the actual page text for indexing.

PDF.js is mature, widely used, and allows extraction to happen locally.

The project includes compatibility shims for APIs expected by modern PDF.js builds inside the Electron environment used by Obsidian.

---

## `onnxruntime-web`

Purpose:

`onnxruntime-web` executes the local sentence embedding model.

It provides the WebAssembly-based ONNX inference runtime used by:

```text
LocalEmbeddingService
```

Why the Web package is used:

The plugin runs inside Obsidian's Electron renderer environment.

Using `onnxruntime-web` avoids requiring a native Node addon to be installed separately on every client machine.

The current implementation uses an external WASM build and caches the matching runtime files locally.

The plugin explicitly provides both:

```text
ort-wasm-simd-threaded.mjs
ort-wasm-simd-threaded.wasm
```

to prevent ONNX Runtime from attempting to load files from an invalid Obsidian application URL.

The runtime is currently configured conservatively with one WASM thread to avoid worker and Content Security Policy complications inside Electron.

---

## `@huggingface/tokenizers`

Purpose:

This package performs tokenization for the local embedding model.

It converts text into inputs such as:

```text
input_ids
attention_mask
token_type_ids
```

Why it is used:

The project intentionally does not use `@huggingface/transformers`.

The earlier Transformers.js approach introduced a dependency chain involving `sharp`, which created security audit issues unrelated to the text-only use case.

Local Vault AI only needs:

```text
tokenization
+
ONNX inference
```

Using `@huggingface/tokenizers` directly keeps the embedding stack much smaller and avoids pulling in image-processing dependencies that the plugin does not need.

---

## Why `@huggingface/transformers` Is Not Used

This dependency is intentionally excluded.

The original local embedding implementation used Transformers.js because it offered a convenient high-level pipeline.

However, the package introduced dependencies that included `sharp`.

At the time of the change, `sharp` inherited security advisories from its native image-processing libraries and the dependency chain could not be cleanly resolved through an available upstream fix.

Local Vault AI only performs text embeddings.

The image-processing functionality was unnecessary.

The local embedding implementation was therefore rewritten as:

```text
@huggingface/tokenizers
+
onnxruntime-web
```

This provides the required functionality without the unnecessary image stack.

---

## esbuild

Package:

```text
esbuild
```

Purpose:

esbuild bundles the TypeScript project into the JavaScript file loaded by Obsidian.

It handles:

- TypeScript transpilation.
- Dependency bundling.
- Module resolution.
- Development builds.
- Production builds.

Why it is used:

Obsidian plugins need a JavaScript entry point.

esbuild is fast enough for watch-mode development and flexible enough to externalize modules supplied by Obsidian and Electron.

The project also uses specific package conditions so the correct browser/WASM variant of ONNX Runtime is bundled.

---

## TypeScript

Package:

```text
typescript
```

Purpose:

TypeScript provides static type checking and compiler tooling.

Why it is used:

This codebase includes several subsystems with structured data contracts:

- Search documents.
- Conversation messages.
- RAG results.
- Index metadata.
- Settings.
- Source metadata.
- Model runtime state.

TypeScript makes these relationships explicit and catches mismatches before they reach the Obsidian runtime.

The project deliberately keeps:

```text
npm run typecheck
```

separate from esbuild so a fast build does not replace full type validation.

---

## Node.js Type Definitions

Package commonly used:

```text
@types/node
```

Purpose:

Provides TypeScript definitions for Node.js APIs referenced by build tooling or compatible runtime code.

Why it is used:

The build system, scripts, and some Electron-compatible code may rely on Node.js types.

It is a development dependency rather than a browser-facing runtime feature.

---

# Dependency Policy

The project follows several dependency guidelines.

## Prefer Local JavaScript Libraries

Where practical, dependencies should run inside the Obsidian process and should not require additional server software.

Examples:

```text
Orama
PDF.js
ONNX Runtime Web
```

## Avoid Unnecessary Native Dependencies

Native dependencies complicate:

- Windows installation.
- macOS installation.
- Linux installation.
- Electron ABI compatibility.
- Packaging.
- Security auditing.

They should only be added when the benefit clearly justifies the additional deployment complexity.

## Keep Embedding and Generation Separate

Embedding libraries exist only to produce vectors.

Ollama remains responsible for generative model inference.

This separation allows:

- Local embeddings.
- LAN-hosted generation.
- Independent embedding model upgrades.
- Smaller local resource usage.

## Do Not Send the Entire Vault to the Model Server

The retrieval pipeline should select a limited number of relevant chunks first.

Only selected context should be included in the generative request.

This reduces:

- Network traffic.
- Context-window usage.
- Model latency.
- Unnecessary exposure of unrelated vault data.

---

# Privacy Model

With local embeddings enabled:

```text
Markdown/PDF files
↓
local extraction
↓
local chunking
↓
local embeddings
↓
local Orama retrieval
```

Only retrieved context required to answer the question is sent to the configured Ollama server.

With remote Ollama embeddings enabled:

```text
chunks
↓
configured Ollama /api/embed
```

are sent to the Ollama server during indexing and query embedding.

The user controls which mode is active.

---

# Rebuilding the Knowledge Index

A rebuild is normally required when:

- The index schema changes.
- The local embedding model changes.
- The embedding provider changes.
- The Ollama embedding model changes.
- Embedding dimensions change.
- Major section/chunk metadata logic changes.

A rebuild is not normally required for:

- UI changes.
- Citation navigation changes.
- Source parsing improvements.
- Conversation UI changes.
- Styling changes.

Conversation files should not be deleted when rebuilding the knowledge index.

---

# Troubleshooting

## TypeScript errors

Run:

```bash
npm run typecheck
```

before debugging runtime behavior.

Type errors often identify mismatched settings, interfaces, or metadata before the plugin is loaded into Obsidian.

---

## Plugin does not update after build

Verify the runtime plugin directory contains the newly generated:

```text
main.js
```

Then reload the plugin in Obsidian.

If using the deployment script:

```bash
npm run deploy:test
```

confirm it points to the intended vault.

---

## Local embedding model fails to initialize

Check that the local embedding cache contains both the model files and the matching ONNX Runtime files.

Typical runtime assets include:

```text
ort-wasm-simd-threaded-<version>.mjs
ort-wasm-simd-threaded-<version>.wasm
```

The `.mjs` and `.wasm` runtime versions must match the installed `onnxruntime-web` package version.

---

## Indexing reports filesystem timeouts

Reduce:

```text
Concurrent filesystem operations
```

from:

```text
2
```

to:

```text
1
```

This is particularly useful for:

- Network drives.
- OneDrive.
- Dropbox.
- External drives.
- Slow or heavily synchronized vaults.

---

## A numbered PDF section cannot be found

The retrieval system should report:

- Which source was resolved.
- Which section was requested.
- Which numbered sections were actually detected.

If the source resolves but the requested section is missing from indexed metadata, the issue is likely in PDF section extraction rather than semantic retrieval.

---

## A source opens but does not jump to the expected printed page

PDF citations use physical PDF pages.

A textbook may display:

```text
printed page 24
```

while that same page is:

```text
PDF page 36
```

The plugin intentionally uses the physical PDF page because that is what Obsidian's PDF viewer requires for navigation.

---

# Release and Packaging Notes

The development repository contains:

```text
TypeScript source
build configuration
npm metadata
shell scripts
documentation
```

The installed Obsidian plugin should remain much smaller.

A release normally includes:

```text
main.js
manifest.json
styles.css
```

Runtime-generated data remains in the user's plugin data directory and should not be bundled into a release.

---

# Summary

Local Vault AI is structured as a local-first Obsidian RAG system.

The major components are intentionally separated:

```text
Vault files
↓
Extraction
↓
Chunking
↓
Embedding
↓
Orama indexing
↓
Source resolution
↓
Retrieval
↓
Selected context
↓
Ollama generation
↓
Cited answer
```

This design keeps the vault searchable, debuggable, and private while still allowing larger generative models to run on a separate Ollama server.

The development workflow remains straightforward:

```bash
npm install

npm run typecheck
npm run build
npm run deploy:test
```

For release packaging:

```bash
npm ci
npm run typecheck
npm run build
npm run package
```
