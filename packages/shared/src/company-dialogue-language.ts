import {
  COMPANY_DIALOGUE_LANGUAGE_LABELS,
  COMPANY_DIALOGUE_LANGUAGES,
  DEFAULT_COMPANY_DIALOGUE_LANGUAGE,
  type CompanyDialogueLanguage,
} from "./constants.js";

const DIALOGUE_LANGUAGE_SET = new Set<string>(COMPANY_DIALOGUE_LANGUAGES);

export function isCompanyDialogueLanguage(value: unknown): value is CompanyDialogueLanguage {
  return typeof value === "string" && DIALOGUE_LANGUAGE_SET.has(value);
}

export function normalizeCompanyDialogueLanguage(value: unknown): CompanyDialogueLanguage {
  return isCompanyDialogueLanguage(value) ? value : DEFAULT_COMPANY_DIALOGUE_LANGUAGE;
}

export function companyDialogueLanguageLabel(language: CompanyDialogueLanguage): string {
  return COMPANY_DIALOGUE_LANGUAGE_LABELS[language];
}

/**
 * Instruction block appended to agent AGENTS.md so user-facing dialogue uses the
 * company language while agent-to-agent coordination stays English.
 */
export function buildCompanyDialogueLanguagePolicy(language: CompanyDialogueLanguage): string {
  const label = companyDialogueLanguageLabel(language);
  return [
    "## Language",
    "",
    `- Communicate with the board and end users in ${label} (${language}).`,
    "- Agent-to-agent (A2A) messages, mailbox traffic, and coordination between agents MUST be in English.",
  ].join("\n");
}

export function appendCompanyDialogueLanguagePolicy(
  instructions: string,
  language: CompanyDialogueLanguage,
): string {
  const policy = buildCompanyDialogueLanguagePolicy(language);
  const trimmed = instructions.trimEnd();
  if (trimmed.includes("## Language") && trimmed.includes("Agent-to-agent (A2A)")) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }
  if (!trimmed) return `${policy}\n`;
  return `${trimmed}\n\n${policy}\n`;
}
