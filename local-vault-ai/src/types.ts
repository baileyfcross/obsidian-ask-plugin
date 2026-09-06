export interface VaultChunk {
  id: string;
  filePath: string;
  fileName: string;
  folder: string;
  title: string;
  heading: string;
  content: string;
  tags: string[];
  links: string[];
  properties: string[];
  mtime: number;
  embedding: number[];
}

export interface RetrievedChunk {
  id: string;
  filePath: string;
  title: string;
  heading: string;
  content: string;
  tags: string[];
  links: string[];
  score: number;
}

export interface ConversationSource {
  filePath: string;
  heading: string;
  score: number;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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
