import {
	ItemView,
	MarkdownRenderer,
	Notice,
	Plugin,
	requestUrl,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE = "local-vault-ai-view";

interface VaultChunk {
	id: string;
	filePath: string;
	heading: string;
	text: string;
	embedding: number[];
}

interface PluginData {
	ollamaUrl: string;
	chatModel: string;
	embeddingModel: string;
	chunks: VaultChunk[];
}

const DEFAULT_DATA: PluginData = {
	ollamaUrl: "http://localhost:11434",
	chatModel: "qwen3:8b",
	embeddingModel: "embeddinggemma",
	chunks: [],
};

interface SearchResult {
	chunk: VaultChunk;
	score: number;
}

interface AnswerResult {
	answer: string;
	sources: SearchResult[];
}

export default class LocalVaultAIPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;

	async onload() {
		const saved = await this.loadData();

		this.data = {
			...DEFAULT_DATA,
			...saved,
			chunks: saved?.chunks ?? [],
		};

		this.registerView(
			VIEW_TYPE,
			(leaf) => new LocalVaultAIView(leaf, this),
		);

		this.addRibbonIcon("bot", "Open Local Vault AI", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-local-vault-ai",
			name: "Open Local Vault AI",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "rebuild-local-vault-ai-index",
			name: "Rebuild AI knowledge index",
			callback: async () => {
				await this.rebuildIndex();
			},
		});
	}

	async activateView() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);

			if (!leaf) {
				return;
			}

			await leaf.setViewState({
				type: VIEW_TYPE,
				active: true,
			});
		}

		this.app.workspace.revealLeaf(leaf);
	}

	async rebuildIndex() {
		const files = this.app.vault.getMarkdownFiles();

		new Notice(`Indexing ${files.length} Markdown files...`);

		const newChunks: VaultChunk[] = [];

		for (const file of files) {
			const markdown = await this.app.vault.cachedRead(file);

			const chunks = chunkMarkdown(file.path, markdown);

			newChunks.push(...chunks);
		}

		const batchSize = 16;

		for (let i = 0; i < newChunks.length; i += batchSize) {
			const batch = newChunks.slice(i, i + batchSize);

			const input = batch.map(
				(chunk) =>
					`Document: ${chunk.filePath}\n` +
					`Section: ${chunk.heading}\n\n` +
					chunk.text,
			);

			const embeddings = await this.embedTexts(input);

			for (let j = 0; j < batch.length; j++) {
				batch[j].embedding = embeddings[j];
			}
		}

		this.data.chunks = newChunks;

		await this.saveData(this.data);

		new Notice(
			`Index complete: ${newChunks.length} chunks from ${files.length} notes.`,
		);
	}

	async embedTexts(input: string[]): Promise<number[][]> {
		const response = await requestUrl({
			url: `${this.data.ollamaUrl}/api/embed`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.data.embeddingModel,
				input,
			}),
		});

		if (response.status >= 400) {
			throw new Error(
				`Ollama embedding request failed: ${response.status}`,
			);
		}

		return response.json.embeddings;
	}

	async askVault(question: string): Promise<AnswerResult> {
		if (this.data.chunks.length === 0) {
			throw new Error(
				"The vault has not been indexed yet. Build the index first.",
			);
		}

		const [questionEmbedding] = await this.embedTexts([question]);

		const results: SearchResult[] = this.data.chunks
			.map((chunk) => ({
				chunk,
				score: cosineSimilarity(
					questionEmbedding,
					chunk.embedding,
				),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, 6);

		const context = results
			.map(
				(result, index) =>
					`[${index + 1}]\n` +
					`File: ${result.chunk.filePath}\n` +
					`Section: ${result.chunk.heading}\n\n` +
					result.chunk.text,
			)
			.join("\n\n--------------------\n\n");

		const systemPrompt = `
You are an assistant for an Obsidian knowledge vault.

Answer using only the supplied vault sources.

Rules:
- Do not invent information not contained in the sources.
- If the vault does not contain enough information, explicitly say so.
- Cite statements using [1], [2], etc.
- Prefer the most directly relevant source.
- The source numbers correspond to the supplied context.
`.trim();

		const userPrompt = `
QUESTION

${question}

VAULT SOURCES

${context}
`.trim();

		const response = await requestUrl({
			url: `${this.data.ollamaUrl}/api/chat`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.data.chatModel,
				stream: false,
				messages: [
					{
						role: "system",
						content: systemPrompt,
					},
					{
						role: "user",
						content: userPrompt,
					},
				],
			}),
		});

		if (response.status >= 400) {
			throw new Error(
				`Ollama chat request failed: ${response.status}`,
			);
		}

		return {
			answer: response.json.message.content,
			sources: results,
		};
	}
}

class LocalVaultAIView extends ItemView {
	private plugin: LocalVaultAIPlugin;

	constructor(
		leaf: WorkspaceLeaf,
		plugin: LocalVaultAIPlugin,
	) {
		super(leaf);

		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "Local Vault AI";
	}

	getIcon() {
		return "bot";
	}

	async onOpen() {
		this.render();
	}

	render() {
		const container = this.contentEl;

		container.empty();

		container.addClass("local-vault-ai");

		container.createEl("h3", {
			text: "Ask your vault",
		});

		container.createEl("div", {
			text:
				`${this.plugin.data.chunks.length} indexed chunks`,
			cls: "local-vault-ai-status",
		});

		const rebuildButton = container.createEl("button", {
			text: "Rebuild index",
		});

		const input = container.createEl("textarea", {
			attr: {
				placeholder:
					"Ask a question about your notes...",
			},
		});

		input.addClass("local-vault-ai-input");

		const askButton = container.createEl("button", {
			text: "Ask",
		});

		const output = container.createDiv({
			cls: "local-vault-ai-output",
		});

		rebuildButton.onclick = async () => {
			rebuildButton.disabled = true;

			try {
				await this.plugin.rebuildIndex();
				this.render();
			} catch (error) {
				console.error(error);

				new Notice(
					error instanceof Error
						? error.message
						: "Indexing failed.",
				);
			} finally {
				rebuildButton.disabled = false;
			}
		};

		askButton.onclick = async () => {
			const question = input.value.trim();

			if (!question) {
				return;
			}

			askButton.disabled = true;

			output.empty();

			output.createEl("p", {
				text: "Thinking...",
			});

			try {
				const result =
					await this.plugin.askVault(question);

				output.empty();

				const answerContainer =
					output.createDiv();

				await MarkdownRenderer.render(
					this.app,
					result.answer,
					answerContainer,
					"",
					this,
				);

				output.createEl("h4", {
					text: "Sources",
				});

				for (
					let i = 0;
					i < result.sources.length;
					i++
				) {
					const resultSource =
						result.sources[i];

					const source =
						resultSource.chunk;

					const button =
						output.createEl("button", {
							text:
								`[${i + 1}] ` +
								`${source.filePath}` +
								(source.heading
									? ` → ${source.heading}`
									: ""),
							cls:
								"local-vault-ai-source",
						});

					button.onclick = async () => {
						const file =
							this.app.vault
								.getAbstractFileByPath(
									source.filePath,
								);

						if (file instanceof TFile) {
							await this.app.workspace
								.getLeaf(false)
								.openFile(file);
						}
					};
				}
			} catch (error) {
				output.empty();

				output.createEl("p", {
					text:
						error instanceof Error
							? error.message
							: "Something went wrong.",
				});

				console.error(error);
			} finally {
				askButton.disabled = false;
			}
		};
	}
}

function chunkMarkdown(
	filePath: string,
	markdown: string,
): VaultChunk[] {
	const chunks: VaultChunk[] = [];

	const lines = markdown.split("\n");

	let heading = "Document";
	let buffer: string[] = [];
	let chunkNumber = 0;

	const flush = () => {
		const text = buffer.join("\n").trim();

		if (!text) {
			buffer = [];
			return;
		}

		chunks.push({
			id: `${filePath}::${chunkNumber++}`,
			filePath,
			heading,
			text,
			embedding: [],
		});

		buffer = [];
	};

	for (const line of lines) {
		const headingMatch =
			line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch) {
			flush();

			heading = headingMatch[2].trim();

			continue;
		}

		buffer.push(line);

		if (buffer.join("\n").length >= 2500) {
			flush();
		}
	}

	flush();

	return chunks;
}

function cosineSimilarity(
	a: number[],
	b: number[],
): number {
	if (
		a.length === 0 ||
		a.length !== b.length
	) {
		return -1;
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];

		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	if (normA === 0 || normB === 0) {
		return 0;
	}

	return (
		dot /
		(Math.sqrt(normA) * Math.sqrt(normB))
	);
}
