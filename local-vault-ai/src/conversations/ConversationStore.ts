import {
  DataAdapter,
  normalizePath,
} from "obsidian";
import {
  Conversation,
  ConversationMessage,
  ConversationSummary,
} from "../types";

interface ConversationIndex {
  conversations: ConversationSummary[];
}

export class ConversationStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly conversationsDir: string,
    private readonly indexPath: string,
  ) {}

  async list(): Promise<
    ConversationSummary[]
  > {
    const index =
      await this.loadIndex();

    return [
      ...index.conversations,
    ].sort(
      (a, b) =>
        b.updatedAt.localeCompare(
          a.updatedAt,
        ),
    );
  }

  async create(): Promise<Conversation> {
    const now =
      new Date().toISOString();

    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    await this.save(conversation);
    return conversation;
  }

  async get(
    id: string,
  ): Promise<Conversation | null> {
    const path =
      this.conversationPath(id);

    if (
      !(await this.adapter.exists(
        path,
      ))
    ) {
      return null;
    }

    const raw =
      await this.adapter.read(path);

    return JSON.parse(
      raw,
    ) as Conversation;
  }

  async appendMessage(
    conversation: Conversation,
    message: ConversationMessage,
  ): Promise<Conversation> {
    const updated: Conversation = {
      ...conversation,
      messages: [
        ...conversation.messages,
        message,
      ],
      updatedAt:
        new Date().toISOString(),
    };

    if (
      updated.title === "New chat" &&
      message.role === "user"
    ) {
      updated.title =
        this.makeTitle(
          message.content,
        );
    }

    await this.save(updated);
    return updated;
  }

  async save(
    conversation: Conversation,
  ): Promise<void> {
    await this.adapter.write(
      this.conversationPath(
        conversation.id,
      ),
      JSON.stringify(
        conversation,
        null,
        2,
      ),
    );

    const index =
      await this.loadIndex();

    const summary:
      ConversationSummary = {
        id: conversation.id,
        title: conversation.title,
        createdAt:
          conversation.createdAt,
        updatedAt:
          conversation.updatedAt,
      };

    const existingIndex =
      index.conversations.findIndex(
        (item) =>
          item.id ===
          conversation.id,
      );

    if (existingIndex >= 0) {
      index.conversations[
        existingIndex
      ] = summary;
    } else {
      index.conversations.push(
        summary,
      );
    }

    await this.saveIndex(index);
  }

  async delete(
    id: string,
  ): Promise<void> {
    const path =
      this.conversationPath(id);

    if (
      await this.adapter.exists(path)
    ) {
      await this.adapter.remove(path);
    }

    const index =
      await this.loadIndex();

    index.conversations =
      index.conversations.filter(
        (item) =>
          item.id !== id,
      );

    await this.saveIndex(index);
  }

  async deleteAll(): Promise<number> {
    const index =
      await this.loadIndex();

    const ids = index.conversations.map(
      (conversation) => conversation.id,
    );

    for (const id of ids) {
      const path =
        this.conversationPath(id);

      if (
        await this.adapter.exists(path)
      ) {
        await this.adapter.remove(path);
      }
    }

    await this.saveIndex({
      conversations: [],
    });

    return ids.length;
  }

  async count(): Promise<number> {
    const index =
      await this.loadIndex();

    return index.conversations.length;
  }

  private conversationPath(
    id: string,
  ): string {
    return normalizePath(
      `${this.conversationsDir}/${id}.json`,
    );
  }

  private async loadIndex():
    Promise<ConversationIndex> {
    if (
      !(await this.adapter.exists(
        this.indexPath,
      ))
    ) {
      return {
        conversations: [],
      };
    }

    const raw =
      await this.adapter.read(
        this.indexPath,
      );

    return JSON.parse(
      raw,
    ) as ConversationIndex;
  }

  private async saveIndex(
    index: ConversationIndex,
  ): Promise<void> {
    await this.adapter.write(
      this.indexPath,
      JSON.stringify(
        index,
        null,
        2,
      ),
    );
  }

  private makeTitle(
    content: string,
  ): string {
    const compact = content
      .replace(/\s+/g, " ")
      .trim();

    if (compact.length <= 48) {
      return compact || "New chat";
    }

    return `${compact.slice(
      0,
      45,
    )}...`;
  }
}
