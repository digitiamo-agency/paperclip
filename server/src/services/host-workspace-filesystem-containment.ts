import { unprocessable } from "../errors.js";

/**
 * Digitiamo product rule: host-local agent processes must not see the operator
 * home directory or other paths outside the active workspace.
 *
 * Remote sandbox environments already provide isolation, so they are exempt.
 * Host-local confinement today is Bubblewrap-backed and Linux-only
 * (`filesystemScope: "workspace"` on claude_local / codex_local).
 *
 * Default: required. Disable only for explicit local debugging:
 * `PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE=false`
 */
export const HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE =
  "host_workspace_filesystem_scope_required";

/** Local CLI adapters that can apply Bubblewrap workspace confinement. */
export const HOST_WORKSPACE_CONFINABLE_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
]);

/**
 * Local adapters that spawn a coding CLI on the Paperclip host without a
 * Bubblewrap wrapper today. When host workspace confinement is required, these
 * must run in a sandbox environment instead.
 */
export const HOST_LOCAL_UNCONFINED_ADAPTERS = new Set([
  "cursor_local",
  "opencode_local",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "pi_local",
  "hermes_local",
  "hermes",
]);

function parseEnvFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function isHostWorkspaceFilesystemScopeRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseEnvFlag(
    env.PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE,
    true,
  );
}

function isLocalExecutionTarget(
  executionTarget: { kind?: string } | null | undefined,
): boolean {
  return !executionTarget || executionTarget.kind === "local";
}

/**
 * Enforce Digitiamo host-workspace confinement and return the adapter config to
 * pass into `adapter.execute`. Remote/sandbox targets are unchanged.
 */
export function applyHostWorkspaceFilesystemContainment(input: {
  adapterType: string;
  executionTarget: { kind?: string } | null | undefined;
  config: Record<string, unknown>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const env = input.env ?? process.env;
  if (!isHostWorkspaceFilesystemScopeRequired(env)) return input.config;
  if (!isLocalExecutionTarget(input.executionTarget)) return input.config;

  const platform = input.platform ?? process.platform;
  const adapterType = input.adapterType;

  if (HOST_LOCAL_UNCONFINED_ADAPTERS.has(adapterType)) {
    throw unprocessable(
      `Host-local adapter "${adapterType}" cannot access files outside the workspace, ` +
        "but Paperclip cannot confine it on the host. Use a sandbox environment " +
        "(for example Daytona), or switch to claude_local/codex_local on Linux with Bubblewrap.",
      { code: HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE },
    );
  }

  if (!HOST_WORKSPACE_CONFINABLE_ADAPTERS.has(adapterType)) {
    return input.config;
  }

  if (platform !== "linux") {
    throw unprocessable(
      `Host-local workspace filesystem confinement requires Linux Bubblewrap. ` +
        `This host is "${platform}". Use a sandbox environment for agent execution, ` +
        "or set PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE=false only for local debugging.",
      { code: HOST_WORKSPACE_FILESYSTEM_SCOPE_REQUIRED_CODE },
    );
  }

  // Confinement is CLI-only; ACP cannot wrap the spawn with Bubblewrap.
  return {
    ...input.config,
    filesystemScope: "workspace",
    engine: "cli",
  };
}
