import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FormattedContent,
  type FetchOptions,
  type ThreadInfo,
} from "chat";
import type { WhatsAppWebRawMessage, WhatsAppWebThread } from "./types.js";
import {
  isWhatsAppWebStatusMessage,
  isWhatsAppWebStatusTarget,
} from "./status-guard.js";

export function whatsappWebThreadId(value: WhatsAppWebThread): string {
  return `whatsapp-web:${Buffer.from(value.accountWid).toString("base64url")}:${Buffer.from(value.chatId).toString("base64url")}`;
}

export function parseWhatsAppWebThreadId(value: string): WhatsAppWebThread {
  const match = /^whatsapp-web:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(value);
  if (!match) throw new Error("Invalid WhatsApp Web conversation identity");
  const accountWid = Buffer.from(match[1], "base64url").toString("utf8");
  const chatId = Buffer.from(match[2], "base64url").toString("utf8");
  if (
    !accountWid ||
    !chatId ||
    Buffer.from(accountWid).toString("base64url") !== match[1] ||
    Buffer.from(chatId).toString("base64url") !== match[2]
  ) {
    throw new Error("Invalid WhatsApp Web chat identity");
  }
  return { accountWid, chatId };
}

function textOf(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message) return message.markdown;
  if ("raw" in message) return message.raw;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("fallbackText" in message) return message.fallbackText ?? "";
  throw new Error("WhatsApp Web V1 supports text publications only");
}

export type WhatsAppWebSendFn = (
  chatId: string,
  text: string,
) => Promise<{ id: string }>;

/**
 * First-party Chat SDK adapter for WhatsApp Web (whatsapp-web.js).
 * Inbound events are admitted by the session manager; this class owns
 * identity encoding and outbound text send.
 */
export class WhatsAppWebChatAdapter
  implements Adapter<WhatsAppWebThread, WhatsAppWebRawMessage>
{
  readonly name = "whatsapp-web";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;
  private closed = false;

  constructor(
    readonly userName: string,
    readonly accountWid: string,
    private readonly send: WhatsAppWebSendFn,
  ) {
    this.botUserId = accountWid;
  }

  async initialize(_chat: ChatInstance): Promise<void> {
    /* Session manager owns Chromium lifecycle. */
  }

  async disconnect(): Promise<void> {
    this.closed = true;
  }

  encodeThreadId(value: WhatsAppWebThread): string {
    if (value.accountWid !== this.accountWid) {
      throw new Error("Wrong WhatsApp Web account");
    }
    return whatsappWebThreadId(value);
  }

  decodeThreadId(id: string): WhatsAppWebThread {
    const value = parseWhatsAppWebThreadId(id);
    if (value.accountWid !== this.accountWid) {
      throw new Error("Wrong WhatsApp Web account");
    }
    return value;
  }

  channelIdFromThreadId(id: string): string {
    return this.decodeThreadId(id).chatId;
  }

  isDM(id: string): boolean {
    const { chatId } = this.decodeThreadId(id);
    if (isWhatsAppWebStatusTarget(chatId)) return false;
    return chatId.endsWith("@c.us") || chatId.endsWith("@lid");
  }

  async fetchThread(id: string): Promise<ThreadInfo> {
    const identity = this.decodeThreadId(id);
    return {
      id,
      channelId: identity.chatId,
      channelName: identity.chatId.replace(/@.+$/, ""),
      isDM: this.isDM(id),
      metadata: {},
    };
  }

  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return {
      id,
      name: info.channelName,
      isDM: info.isDM,
      metadata: info.metadata,
    };
  }

  parseMessage(raw: WhatsAppWebRawMessage): Message<WhatsAppWebRawMessage> {
    if (raw.isGroup) {
      throw new Error("WhatsApp Web V1 supports direct messages only");
    }
    if (isWhatsAppWebStatusMessage(raw)) {
      throw new Error("WhatsApp Web V1 ignores Status updates");
    }
    const threadId = this.encodeThreadId({
      accountWid: this.accountWid,
      chatId: raw.chatId,
    });
    const authorId = raw.fromMe ? this.botUserId : raw.from;
    const display = raw.notifyName || raw.from.replace(/@.+$/, "");
    return new Message({
      id: raw.id,
      threadId,
      text: raw.body,
      formatted: parseMarkdown(raw.body),
      raw,
      attachments: [],
      author: {
        userId: authorId,
        userName: display,
        fullName: display,
        isBot: false,
        isMe: raw.fromMe,
        isSystem: false,
      },
      metadata: {
        dateSent: new Date(raw.timestamp * 1000),
        edited: false,
      },
    });
  }

  async fetchMessage(): Promise<null> {
    return null;
  }

  async fetchMessages(_id: string, _options?: FetchOptions) {
    return { messages: [], nextCursor: undefined };
  }

  async getUser(userId: string) {
    return {
      userId,
      fullName: userId.replace(/@.+$/, ""),
      userName: userId.replace(/@.+$/, ""),
      isBot: false,
    };
  }

  async handleWebhook(): Promise<Response> {
    return new Response("WhatsApp Web uses a local paired session", {
      status: 405,
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async startTyping(): Promise<void> {}
  async endTyping(): Promise<void> {}

  async postMessage(
    id: string,
    message: AdapterPostableMessage,
  ): Promise<{ id: string; threadId: string; raw: WhatsAppWebRawMessage }> {
    if (this.closed) throw new Error("WhatsApp Web runtime retired");
    const chatId = this.decodeThreadId(id).chatId;
    if (isWhatsAppWebStatusTarget(chatId)) {
      throw new Error(
        "WhatsApp Web V1 does not publish Status updates or broadcast targets",
      );
    }
    const text = textOf(message);
    const sent = await this.send(chatId, text);
    const raw: WhatsAppWebRawMessage = {
      id: sent.id,
      from: this.accountWid,
      body: text,
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
      isGroup: false,
      chatId,
    };
    return { id: sent.id, threadId: id, raw };
  }

  async editMessage(): Promise<never> {
    throw new Error("WhatsApp Web message edits are not supported in V1");
  }

  async deleteMessage(): Promise<never> {
    throw new Error("WhatsApp Web message deletion is not supported");
  }

  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}

  async publish(
    id: string,
    _publicationId: string,
    message: AdapterPostableMessage,
    options: { assertCurrent(): Promise<void> },
  ): Promise<{ id: string; messageIds: string[] }> {
    await options.assertCurrent();
    const posted = await this.postMessage(id, message);
    return { id: posted.id, messageIds: [posted.id] };
  }
}
