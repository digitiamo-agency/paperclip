import { describe, expect, it } from "vitest";
import {
  appendCompanyDialogueLanguagePolicy,
  buildCompanyDialogueLanguagePolicy,
  normalizeCompanyDialogueLanguage,
} from "./company-dialogue-language.js";

describe("company dialogue language helpers", () => {
  it("defaults unknown values to English", () => {
    expect(normalizeCompanyDialogueLanguage("xx")).toBe("en");
    expect(normalizeCompanyDialogueLanguage("it")).toBe("it");
  });

  it("builds a user-facing vs A2A English policy", () => {
    const policy = buildCompanyDialogueLanguagePolicy("it");
    expect(policy).toContain("Italiano (it)");
    expect(policy).toContain("MUST be in English");
  });

  it("appends the policy once", () => {
    const once = appendCompanyDialogueLanguagePolicy("You are an agent.", "en");
    expect(once).toContain("## Language");
    const twice = appendCompanyDialogueLanguagePolicy(once, "en");
    expect(twice.match(/## Language/g)).toHaveLength(1);
  });
});
