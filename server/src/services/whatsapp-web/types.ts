export type WhatsAppWebPairingPhase =
  | "idle"
  | "starting"
  | "pending_qr"
  | "authenticated"
  | "ready"
  | "failed"
  | "disconnected";

export interface WhatsAppWebPairingStatus {
  phase: WhatsAppWebPairingPhase;
  qr: string | null;
  /** PNG data URL for the current QR payload, when available. */
  qrDataUrl: string | null;
  wid: string | null;
  pushName: string | null;
  error: string | null;
  updatedAt: string;
}

export interface WhatsAppWebThread {
  accountWid: string;
  chatId: string;
}

export interface WhatsAppWebRawMessage {
  id: string;
  from: string;
  to?: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  author?: string;
  notifyName?: string;
  isGroup: boolean;
  /** WhatsApp Status (Stories) update — never admitted or replied to in V1. */
  isStatus?: boolean;
  chatId: string;
}

export const WHATSAPP_WEB_LEASE_KEY = "whatsapp_web_runtime";
