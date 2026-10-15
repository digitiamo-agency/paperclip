import { describe, expect, it } from "vitest";
import { unprocessable } from "../../errors.js";
import {
  assertProjectWorkspaceGitAuthMatchesUrl,
  collectProjectWorkspaceGitAuthSecretRefs,
  readProjectWorkspaceGitAuth,
} from "../project-git-auth.js";

describe("project-git-auth metadata helpers", () => {
  const secretId = "11111111-1111-4111-8111-111111111111";

  it("reads and collects gitAuth secret refs", () => {
    const metadata = { gitAuth: { kind: "ssh_private_key", secretId } };
    expect(readProjectWorkspaceGitAuth(metadata)).toEqual({ kind: "ssh_private_key", secretId });
    expect(collectProjectWorkspaceGitAuthSecretRefs(metadata)).toEqual([{
      secretId,
      configPath: "gitAuth.secretId",
      label: "Git SSH private key",
    }]);
  });

  it("requires SSH keys for SSH remotes and tokens for HTTP(S)", () => {
    expect(() => assertProjectWorkspaceGitAuthMatchesUrl(
      "git@host.example:org/repo.git",
      { kind: "https_token", secretId },
    )).toThrow(/HTTPS token credentials require an HTTP/);

    expect(() => assertProjectWorkspaceGitAuthMatchesUrl(
      "https://host.example/org/repo.git",
      { kind: "ssh_private_key", secretId },
    )).toThrow(/SSH private key credentials require an SSH/);

    expect(() => assertProjectWorkspaceGitAuthMatchesUrl(
      "git@host.example:org/repo.git",
      { kind: "ssh_private_key", secretId },
    )).not.toThrow();
  });

  it("ignores missing gitAuth", () => {
    expect(readProjectWorkspaceGitAuth({})).toBeNull();
    expect(collectProjectWorkspaceGitAuthSecretRefs(null)).toEqual([]);
    expect(() => assertProjectWorkspaceGitAuthMatchesUrl("https://host/org/repo", null)).not.toThrow();
    expect(unprocessable).toBeTypeOf("function");
  });
});
