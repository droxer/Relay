# Share Skills — Design

**Date:** 2026-09-14
**Status:** Proposed
**Branch:** `droxer/share-skills-feature`

## Summary

Relay can see skills but cannot move them. The daemon sweeps each node for
per-CLI `skills/**/SKILL.md` directories (`packages/relay-daemon/src/agent-inventory.ts`),
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
| Per-agent delivery | Explicit CLI flags where they exist (Pi, Kimi); a per-agent config dir only for Claude, which has none. |
| Codex | Has no skills concept. Grants to Codex agents are refused at the boundary, never silently dropped. |
| Missing capability | Non-fatal, but never silent: the run proceeds and says in the thread which skills it lacked. |

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
| `slug` | the on-disk install path, unique **org-wide** among live rows (see below) |
| `displayName`, `description` | `description` mirrors SKILL.md frontmatter and drives catalog search |
| `visibility` | `"private"` \| `"org"` |
| `source` | `"authored"` \| `"upload"` \| `"git"` |
| `sourceRef` | for `git`: `{url, ref, subpath}`; null otherwise |
| `currentRevisionId` | newest revision |
| `createdAt`, `updatedAt`, `deletedAt` | soft delete, so dangling grants stay explainable |

**`skill_revisions`** — immutable. `id`, `skillId`, `revision` (monotonic int),
`manifestSha256`, `bytes`, `createdAt`, `createdByEmployeeId`, `note`.
Editing, re-uploading, or re-importing creates revision N+1; nothing is edited
in place. `manifestSha256` is the sha256 over the sorted `(path, sha256)` list. It is the
*installed-state* key — the daemon compares it against what it last wrote for
this agent to decide whether to touch the directory at all. It is distinct from
the per-blob `sha256`, which keys the content cache.

**`skill_files`** — `revisionId`, `path` (bundle-relative, `SKILL.md` required),
`sha256`, `bytes`, `content`. Content lives in the database, matching the
existing precedent that workspace artifacts keep a content snapshot so reads
survive filesystem churn.

**Install-path collisions.** Uniqueness on `(owner, namespace, name)` is not
enough: two employees may each publish an `org`-visible `code-review`, and an
agent granted both would install them to the same `skills/code-review/`
directory. So a skill also carries `slug` — the directory name it installs as —
unique org-wide among live rows. It defaults to `<namespace>/<name>`; when that
is taken, publish appends the owner's handle (`code-review-alice`) and tells the
publisher what it chose. Resolving this at publish, once, keeps grant and
dispatch free of collision logic.

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

No separate `GET /agents/{id}/skills` route: the agent detail payload already
carries `skills` (`agent_routes.py:380`), and a second endpoint answering the
same question is how the two drift apart.

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
    slug: string;               // the org-unique install directory name
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

`GET /daemon-nodes/{nodeId}/skill-blobs/{sha256}?commandId=…`

Served by `daemon_node_routes.py` behind the same token check as every other
daemon route, and authorized **against the issuing run command**, not against
the node: the blob must belong to a revision named in that command's own
manifest. Scoping to the command instead of to "anything granted anywhere on
this node" is both narrower and cheaper — it is a lookup against one manifest
rather than a scan of every placement and grant on the node. Anything else is
`404`. A steady-state run fetches nothing.

### Isolation mechanism

The CLIs were checked directly rather than assumed, and three of the four offer
an explicit skills path — which is a stronger and simpler isolation seam than
any filesystem arrangement. Verified against the installed binaries (Kimi 0.42.0,
Pi, Claude Code, Codex):

| Agent | Mechanism | Evidence |
|---|---|---|
| **kimi** | `--skills-dir <dir>`, repeatable | help: "Load skills from this directory **instead of** auto-discovered user and project directories" |
| **pi** | `--skill <path>`, repeatable, plus `--no-skills` | help: "Load a skill file or directory (can be used multiple times)" |
| **claude** | `CLAUDE_CONFIG_DIR` → per-agent config dir | no skills-path flag; skills resolve from the config directory |
| **codex** | none — **skills are not a Codex concept** | `codex --help` has `plugin`, `mcp`, `review`; no skills anywhere |

Kimi and Pi are exact: the flags name the granted bundles and nothing else, so
an agent cannot pick up a skill it was not granted even if one sits in the node
home. Kimi's flag explicitly *replaces* discovery, which is precisely the
semantics this design wants.

Claude has no such flag, so it alone needs the config-directory arrangement:
`HOME` stays the node agent home, each logical agent gets

```
<agentHome>/agents/agent-<base64url(agentId)>/.claude/
```

(reusing the `agent-<b64url>` naming from `packages/relay-daemon/src/agent-workspace.ts`),
every entry of the node's `.claude` is mirrored in by symlink **except `skills/`**,
which the daemon owns outright, and `CLAUDE_CONFIG_DIR` points at it. Mirroring
by symlink rather than copy keeps credentials shared and node provisioning a
one-time thing; "everything except `skills/`" means the daemon needs no list of
per-CLI credential filenames and survives a CLI that starts writing new ones.

`AGENT_REGISTRY` (`packages/relay-core/src/agents.ts`) gains one field, a
discriminated union so each agent declares its own mechanism and the
"adding an agent is one registry entry" rule still holds:

```ts
skillDelivery:
  | { kind: "config-dir"; envVar: string; subdir: string; skillsSubpath: string }
  | { kind: "skills-dir-flag"; flag: string }    // kimi: --skills-dir <dir>
  | { kind: "skill-path-flag"; flag: string }    // pi:   --skill <path>
  | { kind: "unsupported" };                     // codex
```

| Agent | `skillDelivery` |
|---|---|
| claude | `{ kind: "config-dir", envVar: "CLAUDE_CONFIG_DIR", subdir: ".claude", skillsSubpath: "skills" }` |
| pi | `{ kind: "skill-path-flag", flag: "--skill" }` |
| kimi | `{ kind: "skills-dir-flag", flag: "--skills-dir" }` |
| codex | `{ kind: "unsupported" }` |

The flag-based kinds need the resolved paths to reach the command builders in
`commands.ts`, which take `(state, workspacePath)`. `AgentState` gains
`skill_paths?: string[]`, alongside the existing `agent_home_subdir` — the same
way per-run context already travels.

New module `packages/relay-daemon/src/agent-skills.ts`, run before the CLI
starts:

1. Fetch any blobs the content cache lacks; unpack each revision to
   `skills/.store/<manifestSha256>/`. This store is append-only and shared by
   every agent on the node — identical revisions are stored once.
2. Then, per the agent's `skillDelivery` kind:
   - **`skill-path-flag` / `skills-dir-flag`** (Pi, Kimi): pass the store paths
     on the command line. Nothing is written per agent, nothing is pruned, and
     the granted set is exactly what the CLI loads.
   - **`config-dir`** (Claude): ensure the per-agent `.claude`, mirror the node's
     entries in by symlink except `skills/`, link `skills/<slug>` into the store
     (see Concurrency), prune stale links, and set `CLAUDE_CONFIG_DIR`.
   - **`unsupported`** (Codex): unreachable — such grants are refused at the API.

### Codex: grants are refused, not ignored

Codex has no skills concept, so a grant to a Codex agent could only ever be a
lie. It is rejected at the boundary instead of silently doing nothing: the grant
route answers `422` naming the executor kind, and the share drawer filters Codex
agents out of the picker with the reason shown rather than leaving them
selectable and inert. If Codex gains skills later, the registry entry changes
from `unsupported` and nothing else does.

### Prerequisite bug fixes

Building on the inventory sweep surfaced two pre-existing defects that must be
fixed first, or the new feature inherits them:

1. **Kimi's inventory directory is dead.** `agent-inventory.ts:43` scans
   `.kimi/skills`, but `~/.kimi/.migrated-to-kimi-code` shows `.kimi` is the
   legacy directory; the live one is `.kimi-code` (which `index.ts:1454` and
   `box.ts:185` already use). Kimi skill inventory has therefore always reported
   empty. Fix the sweep to `.kimi-code/skills`, and likewise
   `index.ts:1216`'s `LOCAL_AGENT_SKILL_DIRS` and `box.ts:258`'s guest
   directory list.
2. **Codex's skills directory is speculative.** `agent-inventory.ts:41` scans
   `.codex/skills`, which Codex never reads. Harmless but misleading — it
   implies a capability that does not exist. Drop it when `skillDelivery` marks
   Codex `unsupported`.

### Concurrency

This section governs the Claude path. Pi and Kimi take paths by flag straight
out of the content-addressed cache, which is append-only, so they have no
mutable per-agent directory to race over at all.

One Claude agent can have two runs in flight at once on the same node (two
threads, or two rounds of different tasks). They share one config directory, so
a naive write-then-prune lets the second run delete a skill the first is
actively reading. The codebase already learned this lesson with task workspaces, where
rounds sharing a directory forced `workspaceRunGate` (`index.ts:239`) to key on
the workspace.

Materialization does not take a lock. It is made idempotent instead:

- Skills install **content-addressed**: `skills/.store/<manifestSha256>/` holds
  the unpacked bundle, and `skills/<slug>` is a symlink to it. Writing a
  revision that is already present is a no-op; two runs racing to install the
  same revision converge on the same bytes.
- Publishing a new set is an atomic symlink swap per slug, so a concurrent run
  sees either the old bundle or the new one, never a half-written directory.
- **Pruning is deferred, not immediate.** A run removes only symlinks, and only
  those not named by *any* manifest currently in flight for that agent; the
  `.store` entries behind them are swept when the agent has no active run. A
  revoked skill's bytes therefore linger briefly rather than vanishing out from
  under a running agent.

That last point has a user-visible consequence worth stating plainly rather than
discovering later: **revocation takes effect at the agent's next dispatch, not
immediately.** A run already executing keeps the skill it started with. Anyone
reading "revoke" as "cut off now" is wrong, and the UI must say so — the Agents
tab labels a revoked-but-not-yet-swept grant "removed at next run". If immediate
cutoff is ever required, it needs run cancellation, not a change here.

### Capability and degradation

New capability `DAEMON_CAPABILITY_AGENT_SKILLS = "agent-skills"`. A daemon
without it runs with no skills materialized. **Non-fatal**, matching the
`task-workspaces` degradation rule: a skill is an enhancement, unlike a project,
which *is* its workspace, and failing the run would strand work over a missing
add-on.

Non-fatal must not mean invisible. A run that silently lacked its skills
produces worse output with no explanation, and the user cannot tell that from
the agent simply doing badly. So the degradation is reported, not just logged:
the backend records the skipped skills on the run, and the thread shows a system
notice naming them and the reason (old daemon, blob fetch failure, unavailable
grant). A run never quietly differs from what was granted.

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
| Grant to a Codex agent | 422 naming the executor kind; the picker excludes them up front |
| Grant of a private skill the caller does not own | 404 (not 403 — do not leak existence) |
| Granted skill deleted | Grant goes dangling; dispatch skips it, UI marks it "unavailable" |
| Pinned revision missing | Same as above; never silently falls back to latest |
| Blob fetch fails mid-materialization | Run proceeds without that skill; recorded and surfaced as a thread notice |
| Daemon lacks `agent-skills` | Run proceeds; skipped skills named in a thread notice |
| Symlink/traversal in an uploaded or imported bundle | Rejected at publish |

Nothing here fails a run. A missing skill degrades capability; it does not
destroy work in progress.

## Testing

**Backend** (`backend/tests/`)
- Revision immutability; edit creates N+1; `manifestSha256` stability across reorderings.
- Uniqueness of `(owner, namespace, name)` among live rows; soft delete frees the name.
- Grant authorization matrix: own/other agent × private/org skill.
- Granting to a Codex agent is rejected 422.
- Bundle resolution: `latest` vs pinned, dangling skill, missing revision, dedupe across grants.
- Slug allocation: a second owner publishing the same `namespace/name` gets a distinct slug, and two such skills granted to one agent install side by side.
- Blob endpoint is scoped to the issuing command: a blob valid for command A is 404 for command B.
- Blob endpoint: daemon token required; 404 for a blob not granted on that node.
- Git import: host allowlist rejection, private-IP rejection, size cap, traversal and symlink rejection.

**Core** (`packages/relay-core/tests/`)
- `AGENT_REGISTRY` declares a `skillDelivery` for all four agents (the `Record<AgentName, …>` type enforces presence); Codex is `unsupported`.
- Command builders emit repeated `--skill` (Pi) and `--skills-dir` (Kimi) for every path in `skill_paths`, and emit nothing when it is empty.

**Daemon** (`packages/relay-daemon/tests/`)
- Materialize writes the manifest; prune removes an ungranted leftover.
- Cache hit by sha means zero fetches on a second identical run.
- **Isolation:** two agents of the same executor kind on one node see disjoint `skills/` contents.
- **Concurrency:** two in-flight runs for one agent with different manifests — neither deletes a skill the other is using; the symlink swap is never observed half-written.
- Re-installing an already-present `manifestSha256` writes nothing.
- Node config entries other than `skills/` are symlinked, not copied; the shared node `skills/` dir is never written.
- Missing capability is a no-op, not an error, and produces a skipped-skills report.
- Pi and Kimi runs write nothing into any per-agent directory — flags only.
- The append-only store keeps one copy when two agents are granted the same revision.

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
- **CLI flags can change under us.** The mechanisms were verified against the
  installed binaries (Kimi 0.42.0, Pi, Claude Code, Codex), but `commands.ts:89`
  already carries a "re-check flags" note for Kimi, so this is a known moving
  target. One question is left for implementation to settle empirically: whether
  Pi's `--no-skills` suppresses discovery while leaving explicit `--skill` paths
  loaded — its sibling `--no-extensions` documents exactly that behavior, but the
  skills flag does not say so. If it does, Pi gains the same replace-discovery
  guarantee Kimi has; if not, Pi's isolation is additive (granted skills load,
  node-installed ones remain visible too) and the UI must not claim otherwise.
  Isolation that silently does not isolate is the one outcome this design must
  not ship.
- **Revoked content lingers until the next dispatch.** Accepted and documented
  above. It is a capability boundary, not a secrets boundary — a skill bundle is
  authored content, not a credential. If skills ever carry secrets, this design
  needs revisiting before that ships.
- **Database-stored bundles grow.** The caps plus content addressing keep this
  bounded; blobs are shared across revisions that did not change a file.
