import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectRepository, ProjectWorkspace } from "@paperclipai/shared";
import { parseGitRemoteUrl } from "@paperclipai/shared";
import { Link } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { ProjectRepositoryInput, repositoryOptionsKey } from "./ProjectRepositoryInput";
import { AddGitRepositoryDialog } from "./AddGitRepositoryDialog";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";

function ManualGitRepositoryRow({
  workspace,
  onEdit,
  onRemove,
  removing,
}: {
  workspace: ProjectWorkspace;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const parsed = workspace.repoUrl ? parseGitRemoteUrl(workspace.repoUrl) : null;
  const gitAuth = workspace.metadata && typeof workspace.metadata === "object"
    && workspace.metadata.gitAuth
    && typeof workspace.metadata.gitAuth === "object"
    ? workspace.metadata.gitAuth as { kind?: string }
    : null;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <Link className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium" title={workspace.name}>{workspace.name}</span>
        <span className="truncate text-xs text-muted-foreground" title={workspace.repoUrl ?? undefined}>
          {workspace.repoUrl}
          {parsed ? ` · ${parsed.transport.toUpperCase()}` : ""}
          {gitAuth?.kind === "ssh_private_key" ? " · SSH key" : gitAuth?.kind === "https_token" ? " · token" : ""}
          {workspace.defaultRef || workspace.repoRef ? ` · ${(workspace.defaultRef ?? workspace.repoRef)!}` : ""}
        </span>
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={onEdit}>Edit</Button>
      <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={onRemove}>Remove</Button>
    </div>
  );
}

export function ProjectRepositories({ project }: { project: Project }) {
  const client = useQueryClient();
  const saved: ProjectRepository[] = project.workspaces.flatMap((workspace) => {
    const id = workspace.metadata?.githubRepositoryId;
    return typeof id === "string" && workspace.repoUrl ? [{ id, fullName: workspace.name, url: workspace.repoUrl, connections: [] }] : [];
  });
  const manualWorkspaces = project.workspaces.filter((workspace) =>
    workspace.repoUrl && !workspace.metadata?.githubRepositoryId);
  const [draft, setDraft] = useState<ProjectRepository[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<ProjectWorkspace | null>(null);
  const save = useMutation({
    mutationFn: () => projectsApi.setRepositories(project.id, (draft ?? saved).map((repo) => repo.id)),
    onSuccess: (updated) => {
      for (const ref of new Set([project.id, project.urlKey])) {
        client.setQueriesData({ queryKey: queryKeys.projects.detail(ref) }, updated);
        void client.invalidateQueries({ queryKey: queryKeys.projects.detail(ref) });
      }
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      setDraft(null);
    },
  });
  const removeManual = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: async () => {
      for (const ref of new Set([project.id, project.urlKey])) {
        await client.invalidateQueries({ queryKey: queryKeys.projects.detail(ref) });
      }
      await client.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
    },
  });
  return <section aria-label="Repositories" className="flex min-w-0 flex-col gap-4 py-4">
    <ProjectRepositoryInput
      companyId={project.companyId}
      selected={draft ?? saved}
      onChange={(repos) => { setDraft(repos); save.reset(); }}
      onConnect={() => setConnecting(true)}
      onAddByUrl={() => { setEditingWorkspace(null); setUrlDialogOpen(true); }}
      disabled={save.isPending}
    />
    {manualWorkspaces.map((workspace) => (
      <ManualGitRepositoryRow
        key={workspace.id}
        workspace={workspace}
        removing={removeManual.isPending}
        onEdit={() => { setEditingWorkspace(workspace); setUrlDialogOpen(true); }}
        onRemove={() => removeManual.mutate(workspace.id)}
      />
    ))}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {save.isError && <p role="alert" className="mr-auto text-sm text-destructive">{save.error.message}</p>}
      {removeManual.isError && <p role="alert" className="mr-auto text-sm text-destructive">{removeManual.error.message}</p>}
      {save.isSuccess && <span role="status" className="mr-auto text-sm text-muted-foreground">Changes saved</span>}
      {draft && <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { setDraft(null); save.reset(); }}>Discard changes</Button>}
      <Button type="button" disabled={!draft || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save changes"}</Button>
    </div>
    <Dialog open={connecting} onOpenChange={setConnecting}><DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-(--sz-calc-18) overflow-y-auto sm:max-w-2xl">
      <DialogTitle className="sr-only">Connect GitHub</DialogTitle>
      <ConnectionSetupFlow host="dialog" serviceSlug="github" forceNewConnection onCancel={() => setConnecting(false)} onComplete={() => {
        void client.invalidateQueries({ queryKey: repositoryOptionsKey(project.companyId) });
        setConnecting(false);
      }} />
    </DialogContent></Dialog>
    {urlDialogOpen && (
      <AddGitRepositoryDialog
        key={editingWorkspace?.id ?? "new-git-repo"}
        open={urlDialogOpen}
        onOpenChange={(open) => {
          setUrlDialogOpen(open);
          if (!open) setEditingWorkspace(null);
        }}
        companyId={project.companyId}
        projectId={project.id}
        projectRef={project.urlKey}
        workspace={editingWorkspace}
      />
    )}
  </section>;
}
