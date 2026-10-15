import { z } from "zod";

/** SCP-style remotes (`git@host:path`) are valid git remotes but not WHATWG URLs. */
export const SCP_LIKE_GIT_REMOTE_PATTERN = /^[^@:/\s]+@[^@:/\s]+:\S+$/;

export type GitRemoteTransport = "http" | "https" | "ssh";

export type ParsedGitRemoteUrl = {
  transport: GitRemoteTransport;
  host: string;
  /** Path without leading slash and without a trailing `.git`. */
  path: string;
  /** Credential-free remote string suitable for persistence. */
  url: string;
};

function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * Parse and normalize a git remote URL for project source repositories.
 * Accepts HTTPS, HTTP, `ssh://`, and SCP-style (`git@host:path`) remotes.
 * Inline userinfo passwords and query/fragment are rejected or stripped.
 */
export function parseGitRemoteUrl(value: string): ParsedGitRemoteUrl | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return null;

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      const path = stripGitSuffix(parsed.pathname.replace(/^\/+/, ""));
      if (!path || path.split("/").some((part) => part === "." || part === "..")) return null;
      const host = parsed.hostname.toLowerCase();
      if (!host) return null;
      const port = parsed.port ? `:${parsed.port}` : "";
      const url = `${protocol}//${host}${port}/${path}`;
      return {
        transport: protocol === "http:" ? "http" : "https",
        host,
        path,
        url,
      };
    }
    if (protocol === "ssh:" || protocol === "git+ssh:") {
      if (parsed.password || parsed.search || parsed.hash) return null;
      const path = stripGitSuffix(parsed.pathname.replace(/^\/+/, ""));
      if (!path || path.split("/").some((part) => part === "." || part === "..")) return null;
      const host = parsed.hostname.toLowerCase();
      if (!host) return null;
      const user = parsed.username || "git";
      const port = parsed.port ? `:${parsed.port}` : "";
      const url = `ssh://${user}@${host}${port}/${path}`;
      return { transport: "ssh", host, path, url };
    }
    return null;
  } catch {
    if (!SCP_LIKE_GIT_REMOTE_PATTERN.test(trimmed)) return null;
    const colon = trimmed.indexOf(":");
    const at = trimmed.indexOf("@");
    if (colon <= at + 1) return null;
    const userHost = trimmed.slice(0, colon);
    const path = stripGitSuffix(trimmed.slice(colon + 1).replace(/^\/+/, ""));
    const atIndex = userHost.lastIndexOf("@");
    if (atIndex <= 0) return null;
    const host = userHost.slice(atIndex + 1).toLowerCase();
    const user = userHost.slice(0, atIndex);
    if (!host || !user || !path || path.split("/").some((part) => part === "." || part === "..")) {
      return null;
    }
    return {
      transport: "ssh",
      host,
      path,
      url: `${user}@${host}:${path}`,
    };
  }
}

export function deriveGitRemoteDisplayName(value: string): string {
  const parsed = parseGitRemoteUrl(value);
  if (!parsed) return value.trim();
  const segments = parsed.path.split("/").filter(Boolean);
  if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return segments[segments.length - 1] ?? parsed.url;
}

export const gitRemoteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((value, ctx) => {
    if (!parseGitRemoteUrl(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must be an HTTP(S) or SSH git remote URL (for example https://host/org/repo.git or git@host:org/repo.git)",
      });
    }
  })
  .transform((value) => parseGitRemoteUrl(value)!.url);

export const projectWorkspaceGitAuthSchema = z
  .object({
    kind: z.enum(["ssh_private_key", "https_token"]),
    secretId: z.string().guid(),
  })
  .strict();

export type ProjectWorkspaceGitAuth = z.infer<typeof projectWorkspaceGitAuthSchema>;
