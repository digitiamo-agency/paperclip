import { describe, expect, it, vi } from "vitest";
import {
  WhatsAppWebChatAdapter,
  parseWhatsAppWebThreadId,
  whatsappWebThreadId,
} from "./adapter.js";

describe("WhatsAppWebChatAdapter", () => {
  it("encodes and decodes DM thread identities", () => {
    const thread = {
      accountWid: "15551234567:12@lid",
      chatId: "15557654321@c.us",
    };
    const id = whatsappWebThreadId(thread);
    expect(parseWhatsAppWebThreadId(id)).toEqual(thread);
  });

  it("normalizes inbound DM text and rejects groups", () => {
    const adapter = new WhatsAppWebChatAdapter(
      "Agent",
      "15551234567:12@lid",
      vi.fn(),
    );
    const message = adapter.parseMessage({
      id: "true_15557654321@c.us_ABCDEF",
      from: "15557654321@c.us",
      body: "hello",
      fromMe: false,
      timestamp: 1_700_000_000,
      notifyName: "Ada",
      isGroup: false,
      chatId: "15557654321@c.us",
    });
    expect(message.text).toBe("hello");
    expect(message.author.userName).toBe("Ada");
    expect(adapter.isDM(message.threadId)).toBe(true);
    expect(() =>
      adapter.parseMessage({
        id: "g",
        from: "1@g.us",
        body: "nope",
        fromMe: false,
        timestamp: 1,
        isGroup: true,
        chatId: "1@g.us",
      }),
    ).toThrow(/direct messages only/i);
  });

  it("publishes text through the session send function", async () => {
    const send = vi.fn(async () => ({ id: "out-1" }));
    const adapter = new WhatsAppWebChatAdapter(
      "Agent",
      "me@c.us",
      send,
    );
    const threadId = whatsappWebThreadId({
      accountWid: "me@c.us",
      chatId: "them@c.us",
    });
    const sent = await adapter.publish(threadId, "pub-1", "pong", {
      assertCurrent: async () => {},
    });
    expect(send).toHaveBeenCalledWith("them@c.us", "pong");
    expect(sent).toEqual({ id: "out-1", messageIds: ["out-1"] });
  });

  it("rejects Status updates inbound and outbound", async () => {
    const send = vi.fn(async () => ({ id: "out-status" }));
    const adapter = new WhatsAppWebChatAdapter("Agent", "me@c.us", send);
    expect(() =>
      adapter.parseMessage({
        id: "s1",
        from: "status@broadcast",
        body: "hello status",
        fromMe: false,
        timestamp: 1,
        isGroup: false,
        isStatus: true,
        chatId: "status@broadcast",
      }),
    ).toThrow(/Status updates/i);

    const statusThread = whatsappWebThreadId({
      accountWid: "me@c.us",
      chatId: "status@broadcast",
    });
    expect(adapter.isDM(statusThread)).toBe(false);
    await expect(adapter.postMessage(statusThread, "nope")).rejects.toThrow(
      /Status updates/i,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
