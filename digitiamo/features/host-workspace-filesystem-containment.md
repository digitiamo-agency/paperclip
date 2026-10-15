# Host workspace filesystem containment (Digitiamo)

## Product rule

Agent processes must not read or write paths outside the active project workspace.

## Why

Local CLI adapters (`*_local`) historically spawn on the Paperclip host **without**
an OS sandbox. The coding CLI can therefore `find`/`ls` the operator home directory
and sibling projects (for example under `~/PROJECTS/...`), even when the run `cwd`
is a managed checkout under `~/.paperclip/instances/.../projects/...`.

Upstream already has optional Bubblewrap confinement (`filesystemScope: "workspace"`)
for `claude_local` and `codex_local` on **Linux only**, off by default.

## Digitiamo enforcement

| Case | Behaviour |
|------|-----------|
| Remote / sandbox environment (e.g. Daytona) | Allowed — sandbox is the boundary |
| Host-local `claude_local` / `codex_local` on Linux | Forced `filesystemScope=workspace` + `engine=cli` (requires `bwrap`) |
| Host-local `claude_local` / `codex_local` on macOS/Windows | **Refused** — use a sandbox environment |
| Host-local `opencode_local`, `cursor_local`, and other unconfined CLIs | **Refused** — use a sandbox environment |
| Policy disabled | Escape hatch for local debugging only |

### Env flag

```bash
# Default on this fork: required (unset = on)
PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE=true

# Local debugging only — restores upstream host-local behaviour
PAPERCLIP_REQUIRE_HOST_WORKSPACE_FILESYSTEM_SCOPE=false
```

Put the flag in `~/.paperclip/instances/default/.env` (or the instance `.env`
you already use) and restart `pnpm dev`.

### Failure code

`host_workspace_filesystem_scope_required` — non-retryable preflight failure.

## Operator guidance (macOS)

On Darwin there is no Bubblewrap path in Paperclip. To keep agents productive
while obeying the product rule:

1. Attach a **sandbox** environment (Daytona / sandbox_provider) to the agent or project.
2. Prefer managed checkouts under `~/.paperclip/instances/.../projects/...`.
3. Do not disable the env flag except for short, supervised debugging.

## Code

- `server/src/services/host-workspace-filesystem-containment.ts`
- Applied in `server/src/services/heartbeat/runtime-execution.ts` before legacy `adapter.execute`
- Tests: `server/src/__tests__/host-workspace-filesystem-containment.test.ts`

## Known gaps (follow-ups)

- `paperclip_runner` local host execution is not yet covered by this gate.
- Bubblewrap confinement is not yet wired into `cursor_local` / `opencode_local` / etc.
- macOS OS-level confinement is intentionally fail-closed (upstream notes `sandbox-exec`
  cannot contain detached descendants for command tools).
