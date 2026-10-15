import { describe, expect, it } from "vitest";
import {
  deriveGitRemoteDisplayName,
  gitRemoteUrlSchema,
  parseGitRemoteUrl,
  projectWorkspaceGitAuthSchema,
} from "./git-remote-url.js";

describe("parseGitRemoteUrl", () => {
  it("accepts HTTPS remotes without credentials", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/app.git")).toEqual({
      transport: "https",
      host: "github.com",
      path: "acme/app",
      url: "https://github.com/acme/app",
    });
  });

  it("accepts HTTP remotes on custom hosts", () => {
    expect(parseGitRemoteUrl("http://git.internal:8080/team/service")).toEqual({
      transport: "http",
      host: "git.internal",
      path: "team/service",
      url: "http://git.internal:8080/team/service",
    });
  });

  it("accepts SCP-style SSH remotes including host aliases", () => {
    expect(parseGitRemoteUrl("git@digitiamo.github.com:digitiamo-agency/paperclip.git")).toEqual({
      transport: "ssh",
      host: "digitiamo.github.com",
      path: "digitiamo-agency/paperclip",
      url: "git@digitiamo.github.com:digitiamo-agency/paperclip",
    });
  });

  it("accepts ssh:// remotes", () => {
    expect(parseGitRemoteUrl("ssh://git@gitlab.example/group/repo.git")).toEqual({
      transport: "ssh",
      host: "gitlab.example",
      path: "group/repo",
      url: "ssh://git@gitlab.example/group/repo",
    });
  });

  it("rejects inline credentials and query strings", () => {
    expect(parseGitRemoteUrl("https://user:token@github.com/acme/app.git")).toBeNull();
    expect(parseGitRemoteUrl("https://github.com/acme/app.git?token=1")).toBeNull();
  });
});

describe("gitRemoteUrlSchema", () => {
  it("normalizes accepted remotes", () => {
    expect(gitRemoteUrlSchema.parse("git@host.example:org/repo.git")).toBe("git@host.example:org/repo");
  });

  it("rejects non-git URLs", () => {
    expect(gitRemoteUrlSchema.safeParse("ftp://host/repo").success).toBe(false);
  });
});

describe("projectWorkspaceGitAuthSchema", () => {
  it("accepts ssh and https token refs", () => {
    const secretId = "11111111-1111-4111-8111-111111111111";
    expect(projectWorkspaceGitAuthSchema.parse({ kind: "ssh_private_key", secretId })).toEqual({
      kind: "ssh_private_key",
      secretId,
    });
    expect(projectWorkspaceGitAuthSchema.parse({ kind: "https_token", secretId }).kind).toBe("https_token");
  });
});

describe("deriveGitRemoteDisplayName", () => {
  it("uses owner/repo when available", () => {
    expect(deriveGitRemoteDisplayName("git@host:acme/app.git")).toBe("acme/app");
  });
});
