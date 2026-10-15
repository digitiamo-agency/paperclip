export {
  WhatsAppWebChatAdapter,
  whatsappWebThreadId,
  parseWhatsAppWebThreadId,
} from "./adapter.js";
export {
  WhatsAppWebSession,
  getWhatsAppWebSession,
  peekWhatsAppWebSession,
  stopWhatsAppWebSession,
  resetWhatsAppWebSessionsForTests,
  type WhatsAppWebClientFactory,
  type WhatsAppWebClientLike,
  type WhatsAppWebSessionCallbacks,
} from "./session-manager.js";
export { whatsappWebSessionDir, whatsappWebClientId } from "./auth-store.js";
export {
  WHATSAPP_WEB_LEASE_KEY,
  type WhatsAppWebPairingPhase,
  type WhatsAppWebPairingStatus,
  type WhatsAppWebRawMessage,
  type WhatsAppWebThread,
} from "./types.js";
export {
  WHATSAPP_WEB_AUTO_REPLY_MODES,
  DEFAULT_WHATSAPP_WEB_AUTO_REPLY_POLICY,
  evaluateWhatsAppWebAutoReply,
  normalizeWhatsAppWebContactKey,
  parseWhatsAppWebAutoReplyPolicy,
  withMarkedKnownContact,
  type WhatsAppWebAutoReplyMode,
  type WhatsAppWebAutoReplyPolicy,
  type WhatsAppWebAutoReplyDecision,
} from "./auto-reply-policy.js";
export {
  WHATSAPP_WEB_STATUS_CHAT_ID,
  isWhatsAppWebStatusMessage,
  isWhatsAppWebStatusTarget,
} from "./status-guard.js";
