import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseGitRemoteUrl, type ProjectWorkspace } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { NativeSelect } from "./ui/select";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  projectId: string;
  projectRef: string;
  workspace?: ProjectWorkspace | null;
};

export function AddGitRepositoryDialog({
  open,
  onOpenChange,
  companyId,
  projectId,
  projectRef,
  workspace = null,
}: Props) {
  const client = useQueryClient();
  const existingAuth = workspace?.metadata && typeof workspace.metadata === "object"
    && workspace.metadata.gitAuth
    && typeof workspace.metadata.gitAuth === "object"
    ? workspace.metadata.gitAuth as { kind?: string; secretId?: string }
    : null;
  const [repoUrl, setRepoUrl] = useState(workspace?.repoUrl ?? "");
  const [repoRef, setRepoRef] = useState(workspace?.defaultRef ?? workspace?.repoRef ?? "");
  const [secretId, setSecretId] = useState(existingAuth?.secretId ?? "");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [createNewSecret, setCreateNewSecret] = useState(false);

  const parsed = useMemo(() => parseGitRemoteUrl(repoUrl), [repoUrl]);
  const credentialKind = parsed?.transport === "ssh" ? "ssh_private_key" as const
    : parsed?.transport === "http" || parsed?.transport === "https" ? "https_token" as const
      : null;
  const credentialRequired = credentialKind === "ssh_private_key";

  const secrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!parsed || !credentialKind) throw new Error("Enter a valid HTTP(S) or SSH git remote URL");
      let resolvedSecretId = secretId.trim();
      if (createNewSecret) {
        if (!newSecretName.trim() || !newSecretValue.trim()) {
          throw new Error(credentialKind === "ssh_private_key"
            ? "Provide a secret name and PEM private key"
            : "Provide a secret name and access token");
        }
        const created = await secretsApi.create(companyId, {
          name: newSecretName.trim(),
          value: newSecretValue,
          description: credentialKind === "ssh_private_key"
            ? "SSH private key for project source repository"
            : "HTTPS token for project source repository",
        });
        resolvedSecretId = created.id;
      }
      if (credentialRequired && !resolvedSecretId) {
        throw new Error("Select or create an SSH private key secret");
      }
      const metadata: Record<string, unknown> = { ...(workspace?.metadata ?? {}) };
      if (resolvedSecretId) {
        metadata.gitAuth = { kind: credentialKind, secretId: resolvedSecretId };
      } else {
        delete metadata.gitAuth;
      }

      if (workspace) {
        return projectsApi.updateWorkspace(projectId, workspace.id, {
          repoUrl: parsed.url,
          repoRef: repoRef.trim() || null,
          defaultRef: repoRef.trim() || null,
          sourceType: "git_repo",
          metadata,
        });
      }
      return projectsApi.createWorkspace(projectId, {
        name: parsed.path.split("/").slice(-2).join("/") || parsed.path,
        repoUrl: parsed.url,
        repoRef: repoRef.trim() || null,
        defaultRef: repoRef.trim() || null,
        sourceType: "git_repo",
        metadata,
      });
    },
    onSuccess: async () => {
      for (const ref of new Set([projectId, projectRef])) {
        await client.invalidateQueries({ queryKey: queryKeys.projects.detail(ref) });
      }
      await client.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      await client.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      onOpenChange(false);
      setRepoUrl("");
      setRepoRef("");
      setSecretId("");
      setNewSecretName("");
      setNewSecretValue("");
      setCreateNewSecret(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!save.isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{workspace ? "Edit git repository" : "Add git repository"}</DialogTitle>
          <DialogDescription>
            Connect any HTTP(S) or SSH remote. SSH clones use a company secret key; HTTPS can use a token secret.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending) save.mutate();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="git-repo-url">Repository URL</Label>
            <Input
              id="git-repo-url"
              value={repoUrl}
              disabled={save.isPending}
              placeholder="git@host:org/repo.git or https://host/org/repo.git"
              onChange={(event) => setRepoUrl(event.target.value)}
              required
            />
            {repoUrl.trim() && !parsed && (
              <p className="text-xs text-destructive">Enter a valid HTTP(S) or SSH git remote URL.</p>
            )}
            {parsed && (
              <p className="text-xs text-muted-foreground">
                Detected {parsed.transport.toUpperCase()} remote on {parsed.host}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="git-repo-ref">Default branch / ref <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="git-repo-ref"
              value={repoRef}
              disabled={save.isPending}
              placeholder="main"
              onChange={(event) => setRepoRef(event.target.value)}
            />
          </div>

          {credentialKind && (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  {credentialKind === "ssh_private_key" ? "SSH private key secret" : "HTTPS token secret"}
                  {!credentialRequired && <span className="text-muted-foreground"> (optional)</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {credentialKind === "ssh_private_key"
                    ? "Paperclip stores the key as a company secret and uses it for clone/fetch."
                    : "Optional company secret used as the HTTPS password for this host."}
                </span>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={createNewSecret}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setCreateNewSecret(event.target.checked);
                    if (event.target.checked) setSecretId("");
                  }}
                />
                Create a new secret
              </label>

              {createNewSecret ? (
                <div className="flex flex-col gap-2">
                  <Input
                    aria-label="Secret name"
                    value={newSecretName}
                    disabled={save.isPending}
                    placeholder={credentialKind === "ssh_private_key" ? "deploy-key-my-repo" : "git-token-my-host"}
                    onChange={(event) => setNewSecretName(event.target.value)}
                  />
                  <Textarea
                    aria-label={credentialKind === "ssh_private_key" ? "Private key PEM" : "Access token"}
                    className="min-h-28 font-mono text-xs"
                    value={newSecretValue}
                    disabled={save.isPending}
                    placeholder={credentialKind === "ssh_private_key"
                      ? "-----BEGIN OPENSSH PRIVATE KEY-----"
                      : "ghp_… or other host token"}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                  />
                </div>
              ) : (
                <NativeSelect
                  aria-label="Credential secret"
                  value={secretId}
                  disabled={save.isPending || secrets.isLoading}
                  onChange={(event) => setSecretId(event.target.value)}
                  required={credentialRequired}
                >
                  <option value="">{credentialRequired ? "Select a secret…" : "No secret (public remote)"}</option>
                  {(secrets.data ?? []).filter((secret) => secret.status === "active").map((secret) => (
                    <option key={secret.id} value={secret.id}>{secret.name}</option>
                  ))}
                </NativeSelect>
              )}
            </div>
          )}

          {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !parsed}>
              {save.isPending ? "Saving…" : workspace ? "Save repository" : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
