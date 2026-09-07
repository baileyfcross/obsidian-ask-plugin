import { Notice, Plugin, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, LocalVaultAISettings } from './settings/Settings';
import { LocalVaultAISettingTab } from './settings/SettingsTab';
import { OllamaClient } from './ollama/OllamaClient';
import { ModelRuntimeManager } from './ollama/ModelRuntimeManager';
import { KnowledgeIndex } from './search/KnowledgeIndex';
import { IndexManager } from './indexing/IndexManager';
import {
	ensurePluginPaths,
	getPluginPaths,
	PluginPaths,
} from './storage/PluginPaths';
import { ConversationStore } from './conversations/ConversationStore';
import { RagService } from './rag/RagService';
import { LocalVaultAIView, VIEW_TYPE_LOCAL_VAULT_AI } from './ui/ChatView';
import { LectureService } from './lecture/LectureService';

export default class LocalVaultAIPlugin extends Plugin {
	settings!: LocalVaultAISettings;

	ollama!: OllamaClient;
	modelRuntime!: ModelRuntimeManager;
	knowledgeIndex!: KnowledgeIndex;
	indexManager!: IndexManager;
	conversationStore!: ConversationStore;
	ragService!: RagService;
	lectureService!: LectureService;

	private paths!: PluginPaths;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.paths = getPluginPaths(this.app, this.manifest.id);

		await ensurePluginPaths(this.app, this.paths);

		this.ollama = new OllamaClient(this.settings.ollamaUrl);

		this.modelRuntime = new ModelRuntimeManager(this.ollama);

		this.knowledgeIndex = new KnowledgeIndex(
			this.app.vault.adapter,
			this.paths.indexPath,
		);

		this.indexManager = new IndexManager(
			this.app,
			this.settings,
			this.ollama,
			this.knowledgeIndex,
			this.paths.manifestPath,
		);

		this.conversationStore = new ConversationStore(
			this.app.vault.adapter,
			this.paths.conversationsDir,
			this.paths.conversationsIndexPath,
		);

		this.ragService = new RagService(
			this.ollama,
			this.knowledgeIndex,
			this.settings,
			this.modelRuntime,
		);

		this.lectureService = new LectureService(
			this.ollama,
			this.knowledgeIndex,
			this.settings,
		);

		this.registerView(
			VIEW_TYPE_LOCAL_VAULT_AI,
			(leaf) => new LocalVaultAIView(leaf, this),
		);

		this.addRibbonIcon('bot', 'Open Local Vault AI', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-local-vault-ai',
			name: 'Open Local Vault AI',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'rebuild-local-vault-ai-index',
			name: 'Rebuild Local Vault AI index',
			callback: async () => {
				try {
					await this.indexManager.rebuildAll();
					new Notice('Local Vault AI index rebuilt successfully.');
				} catch (error) {
					new Notice(
						error instanceof Error
							? error.message
							: 'Index rebuild failed.',
					);
				}
			},
		});

		this.addCommand({
			id: 'show-local-vault-ai-index-status',
			name: 'Show Local Vault AI index status',
			callback: () => {
				const status = this.indexManager.getStatus();

				new Notice(
					`${status.message}\n` +
						`${status.documentCount} note(s), ` +
						`${status.chunkCount} chunk(s).`,
				);
			},
		});

		this.addSettingTab(new LocalVaultAISettingTab(this.app, this));

		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.indexManager.initialize();
		});
	}

	onunload(): void {
		this.indexManager?.dispose();

		if (this.indexManager && this.knowledgeIndex?.isReady()) {
			void this.indexManager.flush();
		}

		this.app.workspace.detachLeavesOfType(VIEW_TYPE_LOCAL_VAULT_AI);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);

		this.ollama?.setBaseUrl(this.settings.ollamaUrl);

		if (this.indexManager) {
			await this.indexManager.onSettingsChanged();
		}
	}

	async activateView(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_LOCAL_VAULT_AI,
		)[0];

		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ??
				this.app.workspace.getLeaf(true);

			await leaf.setViewState({
				type: VIEW_TYPE_LOCAL_VAULT_AI,
				active: true,
			});
		}

		this.app.workspace.revealLeaf(leaf);
	}

	async deleteAllConversations(): Promise<number> {
		const deletedCount = await this.conversationStore.deleteAll();

		const leaves = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_LOCAL_VAULT_AI,
		);

		for (const leaf of leaves) {
			if (leaf.view instanceof LocalVaultAIView) {
				await leaf.view.resetAfterConversationClear();
			}
		}

		return deletedCount;
	}

	private async loadSettings(): Promise<void> {
		const saved =
			(await this.loadData()) as Partial<LocalVaultAISettings> | null;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});

		this.normalizeWeights();
	}

	private normalizeWeights(): void {
		const vector = Math.min(
			1,
			Math.max(0, this.settings.hybridVectorWeight),
		);

		this.settings.hybridVectorWeight = vector;

		this.settings.hybridTextWeight = Number((1 - vector).toFixed(2));
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				this.indexManager.handleCreate(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				this.indexManager.handleModify(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on(
				'rename',
				(file: TAbstractFile, oldPath: string) => {
					this.indexManager.handleRename(file, oldPath);
				},
			),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				this.indexManager.handleDelete(file);
			}),
		);
	}
}
