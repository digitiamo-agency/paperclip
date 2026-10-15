import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHATSAPP_WEB_AUTO_REPLY_POLICY,
  evaluateWhatsAppWebAutoReply,
  normalizeWhatsAppWebContactKey,
  parseWhatsAppWebAutoReplyPolicy,
  withMarkedKnownContact,
} from "./auto-reply-policy.js";

describe("WhatsApp Web auto-reply policy", () => {
  it("defaults to none", () => {
    expect(parseWhatsAppWebAutoReplyPolicy(undefined).mode).toBe("none");
    expect(DEFAULT_WHATSAPP_WEB_AUTO_REPLY_POLICY.mode).toBe("none");
  });

  it("normalizes phone and chat ids", () => {
    expect(normalizeWhatsAppWebContactKey("+39 333 1234567")).toBe(
      "393331234567",
    );
    expect(normalizeWhatsAppWebContactKey("393331234567@c.us")).toBe(
      "393331234567@c.us",
    );
  });

  it("blocks everyone in none mode and allows all in all mode", () => {
    expect(
      evaluateWhatsAppWebAutoReply({
        policy: { mode: "none", contacts: [], knownContacts: [] },
        chatId: "1@c.us",
      }).allow,
    ).toBe(false);
    expect(
      evaluateWhatsAppWebAutoReply({
        policy: { mode: "all", contacts: [], knownContacts: [] },
        chatId: "1@c.us",
      }).allow,
    ).toBe(true);
  });

  it("honors allowlist and blocklist by phone digits", () => {
    const allow = evaluateWhatsAppWebAutoReply({
      policy: {
        mode: "allowlist",
        contacts: ["393331234567"],
        knownContacts: [],
      },
      chatId: "393331234567@c.us",
    });
    expect(allow.allow).toBe(true);
    const blocked = evaluateWhatsAppWebAutoReply({
      policy: {
        mode: "blocklist",
        contacts: ["393331234567"],
        knownContacts: [],
      },
      chatId: "393331234567@c.us",
    });
    expect(blocked.allow).toBe(false);
    const pass = evaluateWhatsAppWebAutoReply({
      policy: {
        mode: "blocklist",
        contacts: ["393331234567"],
        knownContacts: [],
      },
      chatId: "39999888777@c.us",
    });
    expect(pass.allow).toBe(true);
  });

  it("replies only to new contacts once", () => {
    const first = evaluateWhatsAppWebAutoReply({
      policy: { mode: "new_only", contacts: [], knownContacts: [] },
      chatId: "1@c.us",
    });
    expect(first.allow).toBe(true);
    const known = withMarkedKnownContact(
      { mode: "new_only", contacts: [], knownContacts: [] },
      "1@c.us",
    );
    const second = evaluateWhatsAppWebAutoReply({
      policy: known,
      chatId: "1@c.us",
    });
    expect(second.allow).toBe(false);
  });
});
