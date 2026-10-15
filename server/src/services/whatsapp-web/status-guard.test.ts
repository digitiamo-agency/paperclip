import { describe, expect, it } from "vitest";
import {
  WHATSAPP_WEB_STATUS_CHAT_ID,
  isWhatsAppWebStatusMessage,
  isWhatsAppWebStatusTarget,
} from "./status-guard.js";

describe("WhatsApp Web status guard", () => {
  it("detects status and broadcast targets", () => {
    expect(isWhatsAppWebStatusTarget(WHATSAPP_WEB_STATUS_CHAT_ID)).toBe(true);
    expect(isWhatsAppWebStatusTarget("120363@broadcast")).toBe(true);
    expect(isWhatsAppWebStatusTarget("15557654321@c.us")).toBe(false);
    expect(isWhatsAppWebStatusTarget("1555:12@lid")).toBe(false);
  });

  it("detects status messages by flag or jid", () => {
    expect(
      isWhatsAppWebStatusMessage({
        isStatus: true,
        from: "15557654321@c.us",
        chatId: "15557654321@c.us",
      }),
    ).toBe(true);
    expect(
      isWhatsAppWebStatusMessage({
        from: WHATSAPP_WEB_STATUS_CHAT_ID,
        chatId: WHATSAPP_WEB_STATUS_CHAT_ID,
      }),
    ).toBe(true);
    expect(
      isWhatsAppWebStatusMessage({
        from: "15557654321@c.us",
        chatId: "15557654321@c.us",
      }),
    ).toBe(false);
  });
});
