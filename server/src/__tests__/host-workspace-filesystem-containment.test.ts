import { describe, expect, it } from "vitest";
import {
  HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE,
  applyHostWorkspaceFilesystemContainment,
  isHostWorkspaceFilesystemScopeRequired,
} from "../services/host-workspace-filesystem-containment.js";

describe("host workspace filesystem containment", () => {
  it("defaults to required when the env flag is unset", () => {
    expect(isHostWorkspaceFilesystemScopeRequired({})).toBe(true);
  });

  it("can be disabled for local debugging", () => {
    expect(
      isHostWorkspaceFilesystemScopeRequired({
        PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE: "false",
      }),
    ).toBe(false);
  });

  it("leaves remote sandbox runs unchanged", () => {
    const config = { model: "x", filesystemScope: undefined };
    expect(
      applyHostWorkspaceFilesystemContainment({
        adapterType: "opencode_local",
        executionTarget: { kind: "remote" },
        config,
        platform: "darwin",
        env: {},
      }),
    ).toBe(config);
  });

  it("forces workspace scope and CLI engine for confinable Linux adapters", () => {
    expect(
      applyHostWorkspaceFilesystemContainment({
        adapterType: "claude_local",
        executionTarget: { kind: "local" },
        config: { model: "claude", engine: "acp" },
        platform: "linux",
        env: {},
      }),
    ).toEqual({
      model: "claude",
      engine: "cli",
      filesystemScope: "workspace",
    });
  });

  it("refuses host-local confinable adapters on macOS", () => {
    try {
      applyHostWorkspaceFilesystemContainment({
        adapterType: "codex_local",
        executionTarget: null,
        config: {},
        platform: "darwin",
        env: {},
      });
      expect.fail("expected containment refusal");
    } catch (error) {
      expect(error).toMatchObject({
        details: { code: HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE },
      });
    }
  });

  it("refuses host-local adapters that cannot be Bubblewrap-confined", () => {
    try {
      applyHostWorkspaceFilesystemContainment({
        adapterType: "opencode_local",
        executionTarget: { kind: "local" },
        config: {},
        platform: "linux",
        env: {},
      });
      expect.fail("expected containment refusal");
    } catch (error) {
      expect(error).toMatchObject({
        details: { code: HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE },
      });
    }
  });

  it("does not rewrite config when the policy is disabled", () => {
    const config = { engine: "acp" };
    expect(
      applyHostWorkspaceFilesystemContainment({
        adapterType: "claude_local",
        executionTarget: { kind: "local" },
        config,
        platform: "darwin",
        env: { PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE: "false" },
      }),
    ).toBe(config);
  });
});
