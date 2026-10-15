import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectWorkspaces, type Db } from "@paperclipai/db";
import {
  parseGitRemoteUrl,
  projectWorkspaceGitAuthSchema,
  type ProjectWorkspaceGitAuth,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import {
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  type GitAuthInvocation,
  type GitCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";

export const PROJECT_WORKSPACE_GIT_AUTH_CONFIG_PATH = "gitAuth.secretId";

export function readProjectWorkspaceGitAuth(
  metadata: Record<string, unknown> | null | undefined,
): ProjectWorkspaceGitAuth | null {
  if (!metadata || metadata.gitAuth == null) return null;
  const parsed = projectWorkspaceGitAuthSchema.safeParse(metadata.gitAuth);
  return parsed.success ? parsed.data : null;
}

export function assertProjectWorkspaceGitAuthMatchesUrl(
  repoUrl: string | null | undefined,
  gitAuth: ProjectWorkspaceGitAuth | null,
): void {
  if (!gitAuth) return;
  const parsed = repoUrl ? parseGitRemoteUrl(repoUrl) : null;
  if (!parsed) {
    throw unprocessable("A git credential requires a valid HTTP(S) or SSH repository URL");
  }
  if (gitAuth.kind === "ssh_private_key" && parsed.transport !== "ssh") {
    throw unprocessable("SSH private key credentials require an SSH repository URL");
  }
  if (gitAuth.kind === "https_token" && parsed.transport !== "http" && parsed.transport !== "https") {
    throw unprocessable("HTTPS token credentials require an HTTP or HTTPS repository URL");
  }
}

export function collectProjectWorkspaceGitAuthSecretRefs(
  metadata: Record<string, unknown> | null | undefined,
): Array<{ secretId: string; configPath: string; label: string }> {
  const gitAuth = readProjectWorkspaceGitAuth(metadata);
  if (!gitAuth) return [];
  return [{
    secretId: gitAuth.secretId,
    configPath: PROJECT_WORKSPACE_GIT_AUTH_CONFIG_PATH,
    label: gitAuth.kind === "ssh_private_key" ? "Git SSH private key" : "Git HTTPS token",
  }];
}

function remoteIdentity(url: string): string {
  const parsed = parseGitRemoteUrl(url);
  if (!parsed) return url.trim().replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
  return `${parsed.transport}://${parsed.host}/${parsed.path}`.toLowerCase();
}

function buildHostScopedHttpsHelper(host: string): string {
  const escapedHost = host.replace(/'/g, `'\\''`);
  return `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=${escapedHost}) ok=1;; protocol=https|protocol=http) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=git\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;
}

async function buildHttpsTokenInvocation(input: {
  host: string;
  protocol: "http" | "https";
  token: string;
  secretName: string | null;
}): Promise<GitAuthInvocation> {
  const helper = buildHostScopedHttpsHelper(input.host);
  const scopedHelperKey = `credential.${input.protocol}://${input.host}.helper`;
  const configEntries: Array<[string, string]> = [
    ["credential.helper", ""],
    [scopedHelperKey, helper],
  ];
  return {
    configArgs: [
      "-c", "credential.helper=",
      "-c", `${scopedHelperKey}=${helper}`,
    ],
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: input.token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: String(configEntries.length),
      ...Object.fromEntries(configEntries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ])),
    },
    source: "company_secret" satisfies GitCredential["source"],
    secretName: input.secretName,
  };
}

async function buildSshKeyInvocation(input: {
  privateKey: string;
  secretName: string | null;
}): Promise<GitAuthInvocation> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-ssh-"));
  const keyPath = path.join(dir, "id");
  await fs.writeFile(keyPath, `${input.privateKey.trim()}\n`, { mode: 0o600 });
  await fs.chmod(keyPath, 0o600);
  const sshCommand = [
    "ssh",
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
  ].join(" ");
  return {
    configArgs: [],
    env: {
      GIT_SSH_COMMAND: sshCommand,
      GIT_TERMINAL_PROMPT: "0",
    },
    source: "company_secret",
    secretName: input.secretName,
    dispose: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Resolve a project-workspace-bound git credential for a remote URL.
 * Returns null when no matching workspace credential is configured.
 */
export async function resolveProjectWorkspaceGitAuthInvocation(
  db: Db,
  companyId: string,
  remoteUrl: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
  },
): Promise<GitAuthInvocation | null> {
  const parsedRemote = parseGitRemoteUrl(remoteUrl);
  if (!parsedRemote) return null;
  const wanted = remoteIdentity(remoteUrl);

  const rows = await db
    .select({
      id: projectWorkspaces.id,
      repoUrl: projectWorkspaces.repoUrl,
      metadata: projectWorkspaces.metadata,
    })
    .from(projectWorkspaces)
    .where(and(
      eq(projectWorkspaces.companyId, companyId),
    ));

  const workspace = rows.find((row) => row.repoUrl && remoteIdentity(row.repoUrl) === wanted);
  if (!workspace) return null;
  const gitAuth = readProjectWorkspaceGitAuth(workspace.metadata as Record<string, unknown> | null);
  if (!gitAuth) return null;

  const secrets = secretService(db);
  const secret = await secrets.getById(gitAuth.secretId).catch(() => null);
  if (!secret || secret.companyId !== companyId || secret.status === "deleted") {
    throw new Error("Configured project repository git credential secret is unavailable");
  }

  const value = await secrets.resolveSecretValue(companyId, gitAuth.secretId, "latest", {
    consumerType: "project_workspace",
    consumerId: workspace.id,
    actorType: "system",
    actorId: null,
    issueId: context?.issueId ?? null,
    heartbeatRunId: context?.heartbeatRunId ?? null,
    responsibleUserId: context?.responsibleUserId ?? null,
    configPath: PROJECT_WORKSPACE_GIT_AUTH_CONFIG_PATH,
  }).then((token) => token.trim());

  if (!value) {
    throw new Error("Configured project repository git credential secret is empty");
  }

  if (gitAuth.kind === "ssh_private_key") {
    if (parsedRemote.transport !== "ssh") return null;
    return buildSshKeyInvocation({ privateKey: value, secretName: secret.name });
  }

  if (parsedRemote.transport !== "http" && parsedRemote.transport !== "https") return null;
  return buildHttpsTokenInvocation({
    host: parsedRemote.host,
    protocol: parsedRemote.transport,
    token: value,
    secretName: secret.name,
  });
}
