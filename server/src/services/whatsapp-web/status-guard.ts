/** WhatsApp Status (Stories) broadcast chat id used by WhatsApp Web. */
export const WHATSAPP_WEB_STATUS_CHAT_ID = "status@broadcast";

/**
 * True when a chat id / JID targets WhatsApp Status publication or updates.
 * V1 never admits these inbound and never sends outbound to them.
 */
export function isWhatsAppWebStatusTarget(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === WHATSAPP_WEB_STATUS_CHAT_ID ||
    normalized.endsWith("@broadcast")
  );
}

export function isWhatsAppWebStatusMessage(input: {
  isStatus?: boolean;
  from?: string | null;
  to?: string | null;
  chatId?: string | null;
}): boolean {
  if (input.isStatus === true) return true;
  return (
    isWhatsAppWebStatusTarget(input.chatId) ||
    isWhatsAppWebStatusTarget(input.from) ||
    isWhatsAppWebStatusTarget(input.to)
  );
}
