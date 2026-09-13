# Share Skills — Design

**Date:** 2026-09-14
**Status:** Proposed
**Branch:** `droxer/share-skills-feature`

## Summary

Relay can see skills but cannot move them. The daemon sweeps each node for
`<home>/<configDir>/skills/**/SKILL.md` (`packages/relay-daemon/src/agent-inventory.ts`),
reports them as inventory, and the web UI renders them read-only —
`AgentProfilePanel.tsx:307` says outright that "installing a skill happens on
the machine". Every skill is therefore installed by hand, per machine, and is
visible to every agent of that executor kind on it.

This design adds an org-level **skill catalog** and a **grant** model. A user
publishes a skill once, chooses whether it is private or shared with the org,
and dispatches it to the agents they pick. At dispatch time the daemon
materializes exactly that agent's granted skills into a per-agent config
directory, so a grant is a physical fact rather than an instruction the agent
may ignore.

## Goals

- Publish a skill once; use it on any computer without touching that computer.
- Dispatch a skill to specific agents, with true per-agent isolation.
- Share skills across an org without giving up ownership boundaries.
- Keep the control plane free of agent execution (the standing invariant).

## Non-goals (v1)

- Run-scoped one-off skill attachment in the composer.
- Background git sync. Re-import is a manual action.
- Harvesting a skill from a node's existing inventory into the catalog.
- Sharing MCP server configurations. Same shape; a later pass.
- Any cross-organization marketplace.

## Decisions

| Question | Decision |
|---|---|
| What is sharing? | A catalog is the source of truth; agents receive grants and pull. |
| How do skills enter it? | Authored in the web UI, uploaded, or imported from a git URL. Not harvested from nodes. |
| Content model | Multi-file bundle (`SKILL.md` + supporting files), immutable revisions. |
| Visibility | Owner-scoped: `private` or `org`. That toggle *is* the share. |
| Grant authority | You may grant only to agents your employee owns (existing ownership seam). |
| Isolation | Real: a per-agent config directory, not a shared directory plus an allowlist. |
| Delivery | Lazy — materialized by the daemon at dispatch. No background reconciler. |

## Data model

A new event-sourced store, `backend/relay/persistence/skill_store.py`, following
the `project_store.py` shape (append-only events, derived snapshots, never
mutate snapshot fields outside replay).

**`skills`** — the catalog entry.

| Field | Notes |
|---|---|
| `id` | uuid |
| `ownerEmployeeId` | the publisher; the authorization anchor |
| `namespace`, `name` | `namespace` optional; `(ownerEmployeeId, namespace, name)` unique among live rows |
| `displayName`, `description` | `description` mirrors SKILL.md frontmatter and drives catalog search |
| `visibility` | `"private"` \| `"org"` |
| `source` | `"authored"` \| `"upload"` \| `"git"` |
| `sourceRef` | for `git`: `{url, ref, subpath}`; null otherwise |
| `currentRevisionId` | newest revision |
| `createdAt`, `updatedAt`, `deletedAt` | soft delete, so dangling grants stay explainable |

**`skill_revisions`** — immutable. `id`, `skillId`, `revision` (monotonic int),
`manifestSha256`, `bytes`, `createdAt`, `createdByEmployeeId`, `note`.
Editing, re-uploading, or re-importing creates revision N+1; nothing is edited
in place. `manifestSha256` is the sha256 over the sorted `(path, sha256)` list
and is the cache key the daemon uses.

**`skill_files`** — `revisionId`, `path` (bundle-relative, `SKILL.md` required),
`sha256`, `bytes`, `content`. Content lives in the database, matching the
existing precedent that workspace artifacts keep a content snapshot so reads
survive filesystem churn.

**Caps** (rejected at publish, not at dispatch): 300 files, 1 MB per file,
4 MB per revision. Paths must be relative, `..`-free, and non-symlink;
executable bits are dropped.

### Grants live on `skillPolicy`

`agent_store.py:50` already carries an opaque `skillPolicy` that nothing reads.
Grants go there rather than in a parallel table, so there is exactly one answer
to "what skills does this agent have":

```json
{
  "version": 1,
  "grants": [
    {
      "skillId": "…",
      "pin": "latest",
      "grantedAt": "2026-09-14T…Z",
      "grantedByEmployeeId": "…"
    }
  ]
}
```

`pin` is `"latest"` or `{"revisionId": "…"}`. Readers tolerate `{}` (today's
value everywhere) and unknown keys, so no backfill is needed.

`skillPolicy` is already in `PLACEMENT_RELEVANT_AGENT_FIELDS`
(`agent_store.py:58`), so granting re-fingerprints placements for free.

## Services and API

One seam owns grant mutation: `backend/relay/services/skill_grants.py`. Routes
read-modify-write `skillPolicy` through it and never hand-edit the field.

New module `backend/relay/api/skill_routes.py`:

- `GET /api/v1/skills` — catalog visible to the caller: their own private skills plus every `org` skill.
- `POST /api/v1/skills` — publish (authored or uploaded bundle).
- `GET /api/v1/skills/{id}` — detail with revision list and file manifest.
- `POST /api/v1/skills/{id}/revisions` — new revision.
- `PATCH /api/v1/skills/{id}` — display name, description, visibility.
- `DELETE /api/v1/skills/{id}` — soft delete.
- `POST /api/v1/skills/{id}/import` — re-import from `sourceRef`.
- `POST /api/v1/skills/{id}/grants` — **the feature verb**: dispatch this skill to a list of agents.
- `DELETE /api/v1/skills/{id}/grants/{agentId}` — revoke.
- `GET /api/v1/agents/{id}/skills` — granted plus node-installed, merged (see below).

Authorization: mutating a skill requires `ownerEmployeeId == caller`. Granting
requires the caller to own the target agent *and* to be able to see the skill.
A `private` skill can only be granted to its owner's own agents; making it
`org` is what unlocks anyone else granting it.

### Merged skill view

`_agent_skills` (`agent_routes.py:384`) keeps reporting node inventory and gains
granted catalog skills, each tagged `source: "node" | "catalog"`. The existing
story ("installed on the machine, read-only here") stays true for node entries;
catalog entries are managed and revocable in place.

## Dispatch-time materialization

### Resolution (backend)

`backend/relay/services/skill_bundle.py` resolves an agent's grants into a
manifest at dispatch: pin → concrete revision, skipping grants whose skill is
deleted or whose pinned revision is gone. The manifest carries **digests only**,
never content:

```ts
interface DaemonRunSkillBundle {
  contract: { name: "relay.agent.skills"; version: 1 };
  skills: Array<{
    skillId: string;
    revisionId: string;
    installPath: string;        // "<namespace>/<name>" or "<name>"
    manifestSha256: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }>;
}
```

Attached to `DaemonNodeRunCommand` as an optional `skills` field
(`packages/relay-core/src/daemon-node-protocol.ts`). Run commands stay small
and constant-size regardless of bundle weight.

### Content fetch (daemon)

The daemon keeps a content-addressed cache at
`~/.relay/daemon-nodes/<sandboxId>/skill-cache/<sha256>` and fetches only blobs
it lacks, from a new daemon-token-authenticated endpoint:

`GET /daemon-nodes/{nodeId}/skill-blobs/{sha256}`

Served by `daemon_node_routes.py`, authorized by the same token check as every
other daemon route, and answering `404` for a blob not reachable from any
revision granted to an agent placed on that node. A steady-state run fetches
nothing.

### Isolation mechanism

`HOME` stays the node agent home. Each logical agent gets its own config
directory:

```
<agentHome>/agents/agent-<base64url(agentId)>/<configSubdir>/
```

reusing the `agent-<b64url>` naming already used by
`packages/relay-daemon/src/agent-workspace.ts`. New module
`packages/relay-daemon/src/agent-home.ts`:

1. Ensure the per-agent config dir exists.
2. Mirror every entry of the node's config dir into it by symlink — **except
   `skills/`**, which the daemon owns outright. Credentials and settings are
   shared, never copied, so node-level provisioning still happens once.
3. Write the granted skills into `skills/<installPath>/` from the cache.
4. Prune anything under `skills/` that is not in this manifest.
5. Point the CLI at it via the per-agent config env var.

Step 2's "mirror everything except `skills/`" rule means the daemon needs no
list of credential filenames per agent CLI, and a new file an agent CLI starts
writing is picked up without a code change.

`AGENT_REGISTRY` (`packages/relay-core/src/agents.ts`) gains one field, keeping
"adding an agent is one registry entry" true. It must reconcile two tables that
disagree today — the inventory sweep's `skillsDir`
(`agent-inventory.ts:39-44`) and the config env vars (`index.ts:1450-1454`):

```ts
configHome: {
  /** Config directory name under a home. */
  subdir: string;
  /** Skills directory relative to subdir; must equal agent-inventory.ts's skillsDir. */
  skillsSubpath: string;
  /** Env vars pointing the CLI at its config, path relative to subdir. */
  env: Array<{ name: string; path: string }>;
}
```

| Agent | `subdir` | `skillsSubpath` | `env` |
|---|---|---|---|
| claude | `.claude` | `skills` | `CLAUDE_CONFIG_DIR` → `""` |
| codex | `.codex` | `skills` | `CODEX_HOME` → `""` |
| pi | `.pi` | `skills` | `PI_CODING_AGENT_DIR` → `agent` |
| kimi | *(see below)* | `skills` | `KIMI_CODE_HOME` → `""` |

Pi is why `env.path` exists at all: its config env points at `.pi/agent` while
its skills live at `.pi/skills`, both under one `.pi` subdir.

**Kimi is unresolved on purpose.** `agent-inventory.ts` scans `.kimi/skills`
while `index.ts:1454` sets `KIMI_CODE_HOME` to `.kimi-code` — two different
directories. One of them is wrong, and the spec deliberately does not guess
which. Implementation confirms against the installed Kimi CLI, fixes whichever
table is wrong as a prerequisite, and only then fills the row. Until it is
confirmed, Kimi takes the fallback path below and reports the degradation.

The per-kind env vars at `index.ts:1450-1454` become per-agent when a bundle is
present, and unchanged otherwise.

`RELAY_AGENT_SKILL_ISOLATION=0` falls back to the node home — an escape hatch
for debugging, not a supported mode.

### Capability and degradation

New capability `DAEMON_CAPABILITY_AGENT_SKILLS = "agent-skills"`. A daemon
without it runs normally with no skills materialized; the backend records a
skipped note on the run. **Non-fatal**, matching the `task-workspaces`
degradation rule — a skill is an enhancement, unlike a project, which *is* its
workspace.

## Git import

The first outbound network call from the control plane, so it is fenced:

- HTTPS only. Host must match `org_settings.skillImportAllowedHosts` (default `["github.com"]`).
- No credentials are ever sent or stored.
- Shallow, single-ref fetch of the archive; no submodules, no hooks, no LFS.
- 30 s timeout; the publish caps above apply to the fetched tree.
- Symlinks, absolute paths, and `..` traversal are rejected outright.
- DNS resolution is checked against private/link-local ranges before connecting.

Import yields an ordinary revision. No background refresh in v1.

## Web surfaces

- **New `skills` route** in `SideNav.tsx` and `App.tsx`, built as a list rail plus
  detail record — the rail-row contract and the record-band geometry the other
  rails already follow. Rail row: name, namespace, visibility pill, granted-agent
  count. Detail tabs: Overview (description, source, current revision, file
  tree), Revisions, Agents.
- **Share drawer** — the existing tabbed agent/team roster picker, multi-select.
  Picking a team is a convenience fan-out: grants are recorded per agent, so a
  later membership change does not silently widen access.
- **`AgentProfilePanel.tsx`** — the skills section splits into "Granted"
  (managed, revocable inline) and "Installed on this computer" (today's
  read-only list). The copy at line 307 is rewritten to describe both.
- i18n keys under `skills_page.*`, plus new `agents_page.skills_*` keys.

## Error handling

| Failure | Behavior |
|---|---|
| Publish missing/invalid frontmatter (`name`, `description`) | 422 with the offending field |
| Bundle over caps | 413, nothing stored |
| Grant to an agent the caller does not own | 403 |
| Grant of a private skill the caller does not own | 404 (not 403 — do not leak existence) |
| Granted skill deleted | Grant goes dangling; dispatch skips it, UI marks it "unavailable" |
| Pinned revision missing | Same as above; never silently falls back to latest |
| Blob fetch fails mid-materialization | Run proceeds without that skill; warning event on the run |
| Daemon lacks `agent-skills` | Run proceeds, skipped note recorded |
| Symlink/traversal in an uploaded or imported bundle | Rejected at publish |

Nothing here fails a run. A missing skill degrades capability; it does not
destroy work in progress.

## Testing

**Backend** (`backend/tests/`)
- Revision immutability; edit creates N+1; `manifestSha256` stability across reorderings.
- Uniqueness of `(owner, namespace, name)` among live rows; soft delete frees the name.
- Grant authorization matrix: own/other agent × private/org skill.
- Bundle resolution: `latest` vs pinned, dangling skill, missing revision, dedupe across grants.
- Blob endpoint: daemon token required; 404 for a blob not granted on that node.
- Git import: host allowlist rejection, private-IP rejection, size cap, traversal and symlink rejection.

**Core** (`packages/relay-core/tests/`)
- `AGENT_REGISTRY` has a complete `configHome` for all four agents (the `Record<AgentName, …>` type enforces presence; the test asserts the values are non-empty and distinct).

**Daemon** (`packages/relay-daemon/tests/`)
- Materialize writes the manifest; prune removes an ungranted leftover.
- Cache hit by sha means zero fetches on a second identical run.
- **Isolation:** two agents of the same executor kind on one node see disjoint `skills/` contents.
- Node config entries other than `skills/` are symlinked, not copied; the shared node `skills/` dir is never written.
- Missing capability is a no-op, not an error.

**Web** (`web/tests/`)
- Skills library rail rendering and visibility pills.
- Share drawer grant/revoke, team fan-out recorded per agent.
- Agent panel groups granted vs node-installed and marks unavailable grants.

## Migration

One Alembic revision, `20260914_0070_add_skill_catalog.py`, creating `skills`,
`skill_revisions`, and `skill_files`. No data backfill: an empty `skillPolicy`
is already a valid v1 grant set.

## Risks

- **Per-agent config dirs multiply on a node.** Bounded by agents placed there,
  and directories are symlink-thin. Pruning of retired agents' dirs is
  deliberately out of scope for v1.
- **Agent CLIs may not honor their config env var uniformly.** Kimi already has
  two contradictory directories recorded in the tree (see above). Implementation
  confirms each CLI before the isolation path is enabled for it; an unconfirmed
  CLI falls back to node home and reports the degradation rather than pretending
  to isolate. Isolation that silently does not isolate is the one outcome this
  design must not ship.
- **Database-stored bundles grow.** The caps plus content addressing keep this
  bounded; blobs are shared across revisions that did not change a file.
