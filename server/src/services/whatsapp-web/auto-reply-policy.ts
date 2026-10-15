export const WHATSAPP_WEB_AUTO_REPLY_MODES = [
  "none",
  "all",
  "allowlist",
  "blocklist",
  "new_only",
] as const;

export type WhatsAppWebAutoReplyMode =
  (typeof WHATSAPP_WEB_AUTO_REPLY_MODES)[number];

export interface WhatsAppWebAutoReplyPolicy {
  mode: WhatsAppWebAutoReplyMode;
  /** Contact keys for allowlist / blocklist (normalized chat ids or phone digits). */
  contacts: string[];
  /** Contacts already seen; used by `new_only`. Server-maintained. */
  knownContacts: string[];
}

export const DEFAULT_WHATSAPP_WEB_AUTO_REPLY_POLICY: WhatsAppWebAutoReplyPolicy =
  {
    mode: "none",
    contacts: [],
    knownContacts: [],
  };

/** Normalize a WhatsApp chat id or phone into comparable keys. */
export function normalizeWhatsAppWebContactKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D+/g, "");
  return digits;
}

export function contactKeyCandidates(chatId: string, from?: string): string[] {
  const keys = new Set<string>();
  for (const raw of [chatId, from ?? ""]) {
    const full = normalizeWhatsAppWebContactKey(raw);
    if (full) keys.add(full);
    const digits = full.includes("@")
      ? full.replace(/@.+$/, "").replace(/\D+/g, "")
      : full.replace(/\D+/g, "");
    if (digits) keys.add(digits);
  }
  return [...keys];
}

function listHasContact(list: string[], candidates: string[]): boolean {
  const normalized = new Set(
    list.map(normalizeWhatsAppWebContactKey).filter(Boolean),
  );
  return candidates.some((key) => normalized.has(key));
}

export function parseWhatsAppWebAutoReplyPolicy(
  value: unknown,
): WhatsAppWebAutoReplyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_WHATSAPP_WEB_AUTO_REPLY_POLICY };
  }
  const raw = value as Record<string, unknown>;
  const mode = WHATSAPP_WEB_AUTO_REPLY_MODES.includes(
    raw.mode as WhatsAppWebAutoReplyMode,
  )
    ? (raw.mode as WhatsAppWebAutoReplyMode)
    : "none";
  const contacts = Array.isArray(raw.contacts)
    ? raw.contacts
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeWhatsAppWebContactKey)
        .filter(Boolean)
        .slice(0, 2_000)
    : [];
  const knownContacts = Array.isArray(raw.knownContacts)
    ? raw.knownContacts
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeWhatsAppWebContactKey)
        .filter(Boolean)
        .slice(0, 10_000)
    : [];
  return { mode, contacts: [...new Set(contacts)], knownContacts: [...new Set(knownContacts)] };
}

export type WhatsAppWebAutoReplyDecision =
  | { allow: true; reason: string; markKnown: boolean }
  | { allow: false; reason: string; markKnown: boolean };

/**
 * Decide whether an inbound DM should wake the agent for an automatic reply.
 * Setup/verification callers should bypass this gate separately.
 */
export function evaluateWhatsAppWebAutoReply(input: {
  policy: WhatsAppWebAutoReplyPolicy;
  chatId: string;
  from?: string;
}): WhatsAppWebAutoReplyDecision {
  const candidates = contactKeyCandidates(input.chatId, input.from);
  const primary =
    normalizeWhatsAppWebContactKey(input.chatId) ||
    candidates[0] ||
    "";
  if (!primary) {
    return { allow: false, reason: "missing_contact", markKnown: false };
  }

  switch (input.policy.mode) {
    case "none":
      return { allow: false, reason: "mode_none", markKnown: true };
    case "all":
      return { allow: true, reason: "mode_all", markKnown: true };
    case "allowlist":
      return listHasContact(input.policy.contacts, candidates)
        ? { allow: true, reason: "allowlist_match", markKnown: true }
        : { allow: false, reason: "allowlist_miss", markKnown: true };
    case "blocklist":
      return listHasContact(input.policy.contacts, candidates)
        ? { allow: false, reason: "blocklist_match", markKnown: true }
        : { allow: true, reason: "blocklist_pass", markKnown: true };
    case "new_only":
      return listHasContact(input.policy.knownContacts, candidates)
        ? { allow: false, reason: "known_contact", markKnown: false }
        : { allow: true, reason: "new_contact", markKnown: true };
  }
}

export function withMarkedKnownContact(
  policy: WhatsAppWebAutoReplyPolicy,
  chatId: string,
  from?: string,
): WhatsAppWebAutoReplyPolicy {
  const next = new Set(policy.knownContacts);
  for (const key of contactKeyCandidates(chatId, from)) next.add(key);
  return {
    ...policy,
    knownContacts: [...next].slice(0, 10_000),
  };
}
