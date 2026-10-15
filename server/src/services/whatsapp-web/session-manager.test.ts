import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WhatsAppWebSession,
  resetWhatsAppWebSessionsForTests,
  type WhatsAppWebClientLike,
} from "./session-manager.js";

afterEach(() => {
  resetWhatsAppWebSessionsForTests();
});

function mockClient(): WhatsAppWebClientLike & {
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    info: { wid: { _serialized: "me@c.us" }, pushname: "Bot" },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
      return this;
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    async initialize() {},
    async destroy() {},
    async sendMessage(chatId, content) {
      return { id: { _serialized: `sent:${chatId}:${content}` } };
    },
  };
}

describe("WhatsAppWebSession", () => {
  it("tracks QR then ready and admits only non-group DMs", async () => {
    const client = mockClient();
    const onMessage = vi.fn();
    const session = new WhatsAppWebSession(
      "company",
      "endpoint",
      { onMessage },
      async () => client,
      "/tmp/paperclip-whatsapp-web-test",
    );

    await session.start();
    client.emit("qr", "qr-payload");
    await vi.waitFor(() => expect(session.status().phase).toBe("pending_qr"));
    expect(session.status().qr).toBe("qr-payload");

    client.emit("ready");
    await vi.waitFor(() => expect(session.status().phase).toBe("ready"));
    expect(session.status().wid).toBe("me@c.us");

    client.emit("message", {
      id: { _serialized: "m1" },
      from: "them@c.us",
      body: "hi",
      fromMe: false,
      timestamp: 10,
      notifyName: "Them",
      getChat: async () => ({
        id: { _serialized: "them@c.us" },
        isGroup: false,
      }),
    });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage.mock.calls[0][0]).toMatchObject({
      body: "hi",
      chatId: "them@c.us",
      isGroup: false,
    });

    client.emit("message", {
      id: { _serialized: "m2" },
      from: "g@g.us",
      body: "group",
      fromMe: false,
      timestamp: 11,
      getChat: async () => ({
        id: { _serialized: "g@g.us" },
        isGroup: true,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onMessage).toHaveBeenCalledTimes(1);

    client.emit("message", {
      id: { _serialized: "m3" },
      from: "status@broadcast",
      body: "my status",
      fromMe: false,
      timestamp: 12,
      isStatus: true,
      getChat: async () => ({
        id: { _serialized: "status@broadcast" },
        isGroup: false,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onMessage).toHaveBeenCalledTimes(1);

    await expect(
      session.sendMessage("status@broadcast", "should not publish"),
    ).rejects.toThrow(/Status updates/i);

    await session.stop();
    expect(session.status().phase).toBe("idle");
  });
});
