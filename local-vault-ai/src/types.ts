export type SourceType =
  | "markdown"
  | "pdf";

export interface VaultChunk {
  id: string;

  /*
   * sourceKey is an enum-indexed copy of filePath.
   * It exists so Orama can apply an exact source
   * filter during a hybrid search.
   */
  sourceKey: string;
  sourceType: SourceType;

  filePath: string;
  fileName: string;
  folder: string;
  title: string;
  heading: string;
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
   * conversations saved before PDF indexing.
   */
  sourceType?: SourceType;
  pageStart?: number;
  pageEnd?: number;
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
