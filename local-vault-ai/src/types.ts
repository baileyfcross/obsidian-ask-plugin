export type SourceType =
  | "markdown"
  | "pdf";

export interface VaultChunk {
  id: string;

  /*
   * Exact-filter fields.
   */
  sourceKey: string;
  sourceType: SourceType;
  sectionKey: string;

  /*
   * Search-friendly normalized source name. This
   * splits CamelCase and removes filename version
   * suffixes before indexing.
   */
  sourceSearchName: string;

  filePath: string;
  fileName: string;
  folder: string;
  title: string;

  heading: string;

  /*
   * Empty strings mean "not a numbered section".
   */
  sectionNumber: string;
  sectionTitle: string;

  content: string;

  tags: string[];
  links: string[];
  properties: string[];

  /*
   * Markdown chunks use 0 / 0.
   * PDF chunks use one-based physical PDF pages.
   */
  pageStart: number;
  pageEnd: number;

  mtime: number;
  embedding: number[];
}

export interface RetrievedChunk {
  id: string;
  sourceType: SourceType;

  filePath: string;
  fileName: string;

  title: string;
  heading: string;

  sectionNumber: string;
  sectionTitle: string;

  content: string;

  tags: string[];
  links: string[];

  pageStart: number;
  pageEnd: number;

  score: number;
}

export interface ConversationSource {
  filePath: string;
  heading: string;
  score: number;

  /*
   * Optional for backward compatibility with
   * conversations saved before PDF section metadata.
   */
  sourceType?: SourceType;
  pageStart?: number;
  pageEnd?: number;
  sectionNumber?: string;
  sectionTitle?: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;

  /*
   * Optional for backward compatibility with
   * conversations created before reasoning UI.
   */
  thinking?: string;

  sources?: ConversationSource[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagAnswer {
  answer: string;
  thinking?: string;
  sources: RetrievedChunk[];
}

export type IndexState =
  | "uninitialized"
  | "ready"
  | "indexing"
  | "needs-rebuild"
  | "error";

export interface IndexStatus {
  state: IndexState;
  message: string;
  documentCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
}
