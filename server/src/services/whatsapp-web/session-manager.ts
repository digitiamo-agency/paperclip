import type {
  WhatsAppWebPairingPhase,
  WhatsAppWebPairingStatus,
  WhatsAppWebRawMessage,
} from "./types.js";
import {
  whatsappWebClientId,
  whatsappWebSessionDir,
} from "./auth-store.js";
import {
  isWhatsAppWebStatusMessage,
  isWhatsAppWebStatusTarget,
} from "./status-guard.js";

export interface WhatsAppWebClientLike {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(
    chatId: string,
    content: string,
  ): Promise<{ id: { _serialized: string } }>;
  info?: { wid?: { _serialized?: string }; pushname?: string };
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WhatsAppWebMessageLike {
  id: { _serialized: string };
  from: string;
  to?: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  author?: string;
  notifyName?: string;
  isStatus?: boolean;
  getChat(): Promise<{ id: { _serialized: string }; isGroup: boolean }>;
}

export type WhatsAppWebClientFactory = (input: {
  companyId: string;
  endpointId: string;
  dataDir: string;
  clientId: string;
}) => Promise<WhatsAppWebClientLike> | WhatsAppWebClientLike;

export interface WhatsAppWebSessionCallbacks {
  onReady?(status: WhatsAppWebPairingStatus): Promise<void> | void;
  onMessage?(message: WhatsAppWebRawMessage): Promise<void> | void;
  onFailure?(error: string): Promise<void> | void;
}

const sessions = new Map<string, WhatsAppWebSession>();

function nowIso(): string {
  return new Date().toISOString();
}

async function defaultClientFactory(input: {
  companyId: string;
  endpointId: string;
  dataDir: string;
  clientId: string;
}): Promise<WhatsAppWebClientLike> {
  // whatsapp-web.js is CJS; ESM `import()` only surfaces Client as a named
  // export and leaves LocalAuth on `.default`, so `new LocalAuth()` fails.
  // createRequire matches the package's real module.exports shape.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { Client, LocalAuth } = require("whatsapp-web.js") as {
    Client: new (opts: Record<string, unknown>) => WhatsAppWebClientLike;
    LocalAuth: new (opts: { clientId: string; dataPath: string }) => unknown;
  };
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  return new Client({
    authStrategy: new LocalAuth({
      clientId: input.clientId,
      dataPath: input.dataDir,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      ...(executablePath ? { executablePath } : {}),
    },
  });
}

export class WhatsAppWebSession {
  private client: WhatsAppWebClientLike | null = null;
  private phase: WhatsAppWebPairingPhase = "idle";
  private qr: string | null = null;
  private qrDataUrl: string | null = null;
  private wid: string | null = null;
  private pushName: string | null = null;
  private error: string | null = null;
  private updatedAt = nowIso();
  private starting: Promise<void> | null = null;

  constructor(
    readonly companyId: string,
    readonly endpointId: string,
    private callbacks: WhatsAppWebSessionCallbacks = {},
    private readonly clientFactory: WhatsAppWebClientFactory = defaultClientFactory,
    private readonly dataRoot?: string,
  ) {}

  setCallbacks(callbacks: WhatsAppWebSessionCallbacks): void {
    this.callbacks = callbacks;
  }

  status(): WhatsAppWebPairingStatus {
    return {
      phase: this.phase,
      qr: this.qr,
      qrDataUrl: this.qrDataUrl,
      wid: this.wid,
      pushName: this.pushName,
      error: this.error,
      updatedAt: this.updatedAt,
    };
  }

  private async setPhase(
    phase: WhatsAppWebPairingPhase,
    patch: Partial<
      Pick<WhatsAppWebPairingStatus, "qr" | "wid" | "pushName" | "error">
    > = {},
  ): Promise<void> {
    this.phase = phase;
    if ("qr" in patch) {
      this.qr = patch.qr ?? null;
      if (this.qr) {
        try {
          const QRCode = await import("qrcode");
          this.qrDataUrl = await QRCode.toDataURL(this.qr, {
            margin: 1,
            width: 280,
          });
        } catch {
          this.qrDataUrl = null;
        }
      } else {
        this.qrDataUrl = null;
      }
    }
    if ("wid" in patch) this.wid = patch.wid ?? null;
    if ("pushName" in patch) this.pushName = patch.pushName ?? null;
    if ("error" in patch) this.error = patch.error ?? null;
    this.updatedAt = nowIso();
  }

  async start(): Promise<WhatsAppWebPairingStatus> {
    if (this.starting) {
      await this.starting;
      return this.status();
    }
    if (this.phase === "ready" && this.client) return this.status();
    this.starting = this.boot();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    return this.status();
  }

  private async boot(): Promise<void> {
    await this.stopInternal();
    await this.setPhase("starting", { qr: null, error: null });
    const dataDir = whatsappWebSessionDir({
      dataRoot: this.dataRoot,
      companyId: this.companyId,
      endpointId: this.endpointId,
    });
    const clientId = whatsappWebClientId(this.endpointId);
    const client = await this.clientFactory({
      companyId: this.companyId,
      endpointId: this.endpointId,
      dataDir,
      clientId,
    });
    this.client = client;

    client.on("qr", (qr) => {
      if (typeof qr !== "string") return;
      void this.setPhase("pending_qr", { qr, error: null });
    });
    client.on("authenticated", () => {
      void this.setPhase("authenticated", { qr: null, error: null });
    });
    client.on("ready", () => {
      const info = client.info;
      const wid =
        typeof info?.wid?._serialized === "string"
          ? info.wid._serialized
          : this.wid;
      const pushName =
        typeof info?.pushname === "string" ? info.pushname : this.pushName;
      void this.setPhase("ready", {
        qr: null,
        wid: wid ?? null,
        pushName: pushName ?? null,
        error: null,
      }).then(() =>
        Promise.resolve(this.callbacks.onReady?.(this.status())).catch(
          () => {},
        ),
      );
    });
    client.on("auth_failure", (message) => {
      const error =
        typeof message === "string" && message
          ? message
          : "WhatsApp Web authentication failed";
      void this.setPhase("failed", { error, qr: null }).then(() =>
        Promise.resolve(this.callbacks.onFailure?.(error)).catch(() => {}),
      );
    });
    client.on("disconnected", (reason) => {
      const error =
        typeof reason === "string" && reason
          ? reason
          : "WhatsApp Web disconnected";
      void this.setPhase("disconnected", { error, qr: null }).then(() =>
        Promise.resolve(this.callbacks.onFailure?.(error)).catch(() => {}),
      );
    });
    client.on("message", (raw) => {
      void this.handleInbound(raw as WhatsAppWebMessageLike).catch(() => {});
    });

    try {
      await client.initialize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start WhatsApp Web";
      await this.setPhase("failed", { error: message, qr: null });
      await this.stopInternal();
      throw error;
    }
  }

  private async handleInbound(msg: WhatsAppWebMessageLike): Promise<void> {
    if (!this.callbacks.onMessage || this.phase !== "ready") return;
    if (msg.fromMe) return;
    if (
      isWhatsAppWebStatusMessage({
        isStatus: msg.isStatus,
        from: msg.from,
        to: msg.to,
      })
    ) {
      return;
    }
    const chat = await msg.getChat();
    if (chat.isGroup) return;
    const chatId = chat.id._serialized;
    if (
      isWhatsAppWebStatusMessage({
        isStatus: msg.isStatus,
        from: msg.from,
        to: msg.to,
        chatId,
      })
    ) {
      return;
    }
    const normalized: WhatsAppWebRawMessage = {
      id: msg.id._serialized,
      from: msg.from,
      to: msg.to,
      body: typeof msg.body === "string" ? msg.body : "",
      fromMe: false,
      timestamp: msg.timestamp,
      author: msg.author,
      notifyName: msg.notifyName,
      isGroup: false,
      isStatus: false,
      chatId,
    };
    if (!normalized.body.trim()) return;
    await this.callbacks.onMessage(normalized);
  }

  async sendMessage(chatId: string, text: string): Promise<{ id: string }> {
    if (!this.client || this.phase !== "ready") {
      throw new Error("WhatsApp Web session is not ready");
    }
    if (isWhatsAppWebStatusTarget(chatId)) {
      throw new Error(
        "WhatsApp Web V1 does not publish Status updates or broadcast targets",
      );
    }
    const result = await this.client.sendMessage(chatId, text);
    return { id: result.id._serialized };
  }

  async stop(): Promise<void> {
    await this.stopInternal();
    await this.setPhase("idle", { qr: null, error: null });
  }

  private async stopInternal(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.destroy();
    } catch {
      /* best-effort teardown */
    }
  }
}

export function getWhatsAppWebSession(
  companyId: string,
  endpointId: string,
  callbacks?: WhatsAppWebSessionCallbacks,
  clientFactory?: WhatsAppWebClientFactory,
): WhatsAppWebSession {
  const existing = sessions.get(endpointId);
  if (existing) {
    if (callbacks) existing.setCallbacks(callbacks);
    return existing;
  }
  const session = new WhatsAppWebSession(
    companyId,
    endpointId,
    callbacks,
    clientFactory,
  );
  sessions.set(endpointId, session);
  return session;
}

export function peekWhatsAppWebSession(
  endpointId: string,
): WhatsAppWebSession | null {
  return sessions.get(endpointId) ?? null;
}

export async function stopWhatsAppWebSession(endpointId: string): Promise<void> {
  const session = sessions.get(endpointId);
  if (!session) return;
  sessions.delete(endpointId);
  await session.stop();
}

/** Test helper: clear in-memory session registry. */
export function resetWhatsAppWebSessionsForTests(): void {
  sessions.clear();
}
