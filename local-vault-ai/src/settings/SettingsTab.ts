import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LocalVaultAIPlugin from '../main';

export class LocalVaultAISettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly localPlugin: LocalVaultAIPlugin,
	) {
		super(app, localPlugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Ollama').setHeading();

		new Setting(containerEl)
			.setName('Server URL')
			.setDesc(
				'Local Ollama API address. The default is http://localhost:11434.',
			)
			.addText((text) =>
				text
					.setPlaceholder('http://localhost:11434')
					.setValue(this.localPlugin.settings.ollamaUrl)
					.onChange(async (value) => {
						this.localPlugin.settings.ollamaUrl = value.trim();

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Connection')
			.setDesc('Verify that Obsidian can reach the local Ollama server.')
			.addButton((button) =>
				button.setButtonText('Test connection').onClick(async () => {
					button.setDisabled(true);

					try {
						const models =
							await this.localPlugin.ollama.listModels();

						new Notice(
							`Connected to Ollama. ${models.length} model(s) installed.`,
						);
					} catch (error) {
						new Notice(
							error instanceof Error
								? error.message
								: 'Could not connect to Ollama.',
						);
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName('Chat model')
			.setDesc(
				'Ollama model used to write answers, for example qwen3:8b.',
			)
			.addText((text) =>
				text
					.setValue(this.localPlugin.settings.chatModel)
					.onChange(async (value) => {
						this.localPlugin.settings.chatModel = value.trim();

						await this.localPlugin.saveSettings();
					}),
			);
			
		new Setting(containerEl)
			.setName('Lecture model')
			.setDesc('Used only when generating lectures or slide decks.')
			.addText((text) =>
				text
					.setValue(this.localPlugin.settings.lectureModel)
					.onChange(async (value) => {
						this.localPlugin.settings.lectureModel = value.trim();

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Embedding model')
			.setDesc(
				'Ollama model used to index and retrieve notes. Changing this requires a full rebuild.',
			)
			.addText((text) =>
				text
					.setValue(this.localPlugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.localPlugin.settings.embeddingModel = value.trim();

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Retrieval').setHeading();

		new Setting(containerEl)
			.setName('Vault only')
			.setDesc(
				'When enabled, answers must be grounded only in retrieved vault content.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.localPlugin.settings.vaultOnly)
					.onChange(async (value) => {
						this.localPlugin.settings.vaultOnly = value;

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Retrieved chunks')
			.setDesc('How many chunks are supplied to the chat model.')
			.addSlider((slider) =>
				slider
					.setLimits(3, 20, 1)
					.setDynamicTooltip()
					.setValue(this.localPlugin.settings.topK)
					.onChange(async (value) => {
						this.localPlugin.settings.topK = value;

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Semantic weight')
			.setDesc(
				'Balances vector similarity against exact text matching. 55% is a good starting point.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setDynamicTooltip()
					.setValue(this.localPlugin.settings.hybridVectorWeight)
					.onChange(async (value) => {
						this.localPlugin.settings.hybridVectorWeight = value;

						this.localPlugin.settings.hybridTextWeight = Number(
							(1 - value).toFixed(2),
						);

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Minimum vector similarity')
			.setDesc(
				'Lower values retrieve more semantic matches. Start at 0.35 and tune using your vault.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setDynamicTooltip()
					.setValue(this.localPlugin.settings.minVectorSimilarity)
					.onChange(async (value) => {
						this.localPlugin.settings.minVectorSimilarity = value;

						await this.localPlugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Conversations').setHeading();

		new Setting(containerEl)
			.setName('Delete all conversations')
			.setDesc(
				'Permanently deletes every saved Local Vault AI chat. This does not delete or rebuild the knowledge index.',
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Delete all chats')
					.onClick(() => {
						new DeleteAllConversationsModal(this.app, async () => {
							const deletedCount =
								await this.localPlugin.deleteAllConversations();

							new Notice(
								`Deleted ${deletedCount} saved conversation(s).`,
							);

							this.display();
						}).open();
					}),
			);

		new Setting(containerEl).setName('Indexing').setHeading();

		new Setting(containerEl)
			.setName('Automatic indexing')
			.setDesc('Automatically re-index a Markdown note after it changes.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.localPlugin.settings.autoIndex)
					.onChange(async (value) => {
						this.localPlugin.settings.autoIndex = value;

						await this.localPlugin.saveSettings();
					}),
			);

		const status = this.localPlugin.indexManager.getStatus();

		new Setting(containerEl)
			.setName('Index status')
			.setDesc(
				`${status.message}\n` +
					`${status.documentCount} note(s), ${status.chunkCount} chunk(s).`,
			);

		new Setting(containerEl)
			.setName('Rebuild knowledge index')
			.setDesc(
				'Recreates the knowledge index and embeddings from the current vault. Saved conversations are preserved.',
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Rebuild index')
					.onClick(async () => {
						button.setDisabled(true);

						try {
							await this.localPlugin.indexManager.rebuildAll();
							new Notice(
								'Local Vault AI index rebuilt successfully.',
							);
							this.display();
						} catch (error) {
							new Notice(
								error instanceof Error
									? error.message
									: 'Index rebuild failed.',
							);
						} finally {
							button.setDisabled(false);
						}
					}),
			);
	}
}

class DeleteAllConversationsModal extends Modal {
	constructor(
		app: App,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.empty();

		contentEl.createEl('h2', {
			text: 'Delete all conversations?',
		});

		contentEl.createEl('p', {
			text:
				'This permanently deletes every saved Local Vault AI conversation. ' +
				'Your Obsidian notes and knowledge index will not be changed.',
		});

		contentEl.createEl('p', {
			text: 'This action cannot be undone.',
		});

		const buttons = contentEl.createDiv();

		const cancel = buttons.createEl('button', {
			text: 'Cancel',
		});

		cancel.onclick = () => {
			this.close();
		};

		const confirm = buttons.createEl('button', {
			text: 'Delete all chats',
		});

		confirm.addClass('mod-warning');

		confirm.onclick = async () => {
			confirm.disabled = true;
			cancel.disabled = true;

			try {
				await this.onConfirm();
				this.close();
			} catch (error) {
				new Notice(
					error instanceof Error
						? error.message
						: 'Could not delete conversations.',
				);

				confirm.disabled = false;
				cancel.disabled = false;
			}
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
