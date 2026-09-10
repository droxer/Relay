# Produced files: unifying artifacts and workspace for tasks and routines

**Date:** 2026-09-10
**Status:** Approved design, not yet implemented
**Scope:** The concept behind a task's files — what is recorded, what is stored, and how one surface presents both. Backend, daemon, and web.

## Problem

A backlog task or routine presents its files through two sibling sections in
`TaskDrawer`: `TaskDrawerArtifacts` (the durable index) and
`TaskDrawerWorkspace` (a live directory browse). They are not two kinds of
thing. An artifact is a workspace file that passed an extension allowlist,
changed during a run, and was small enough to snapshot. The two lists are the
same files, filtered differently, and the UI gives a reader no way to tell
that.

Three independent properties have been fused into that one section boundary:

- **Provenance** — did a run of this task produce it? Artifacts carry an
  `agentRunId`; workspace entries carry nothing.
- **Durability** — is there a stored copy readable when the computer is
  offline? Only for artifacts, and only under
  `WORKSPACE_ARTIFACT_CONTENT_MAX_BYTES` (2 MB).
- **Currency** — are these the bytes on disk right now? Workspace entries
  always; an artifact snapshot goes stale the moment a later run rewrites the
  file.

The fusion produces concrete defects:

1. **Coding tasks have no output.** `_is_generated_artifact_path` indexes
   documents only. An agent that spends three runs writing `main.py` and
   `schema.sql` produces an empty artifact list.
2. **The same file appears twice** with no indication it is one file, one card
   and one tree row, silently disagreeing whenever a later run rewrites it.
3. **Durability is invisible.** A 40 MB `.zip` is listed as an artifact but was
   never snapshotted, so it fails exactly like a live read when the computer is
   down — while sitting in the section that implies it cannot.
4. **Routines aggregate on two axes at once.** A routine never runs. Its
   artifacts roll up across occurrences into one flat list; its workspace is a
   directory *of occurrence directories*. Same heading level, different mental
   model.
5. **Live-read failure is top-level UI copy.** Five states — `not-created`,
   `offline`, `unsupported`, `denied`, `unavailable` — each with its own
   string, in the section the durable index already covers.

## Decisions

Four decisions were settled during design and are fixed for this spec:

1. **One Files surface.** Provenance and durability become per-file properties,
   not a section boundary.
2. **Index-first.** Rows come from indexed records; a live read enriches them
   and contributes a secondary tier. The surface always renders, online or not.
3. **Any changed file counts as produced.** The extension allowlist stops
   deciding provenance.
4. **Snapshotting does not widen.** Only today's allowlisted, secret-scanned
   types get stored bytes. The stored-bytes surface does not grow by one file
   type, so the secret gate's coverage assumption stays exactly as audited.

## The model

One concept: a **produced file** — a workspace file that a run of this task
created or modified. The three fused axes become three explicit fields.

### Provenance

Already recorded as `agentRunId` on the artifact record, plus `agentId`. This
now defines which rows exist rather than decorating rows chosen by extension.

### Durability

New field on the artifact record:

```
snapshotSkipped: null
  | "too-large"             # over the per-file cap or the per-event budget
  | "not-snapshotable-type" # outside the storage allowlist
  | "sensitive"             # content secret-scan tripped
  | "unreadable"            # vanished or unreadable between walk and read
```

This is the load-bearing addition. Today "not snapshotted" is expressed by the
record not existing, so a reader cannot distinguish a file that was not
produced from one that was produced but could not be stored. As an explicit
enum, a row can say *attributed, live-only, because it is 240 MB*.

`null` means bytes are stored. The field is absent on every pre-existing
record; absence renders as "stored if `snapshotPath`/content exists, unknown
reason otherwise", which is exactly today's behavior.

### Currency

Derived per request, never stored. The `/tasks/{id}/files` handler compares the
live listing's `(bytes, mtime)` against each record and reports the result;
computing it in one place keeps it testable in Python and stops two clients
from deriving it differently.

| State | Meaning |
|---|---|
| `current` | live entry matches the record |
| `changed-since` | live entry exists with different size or mtime |
| `deleted` | record exists, no live entry |
| `unknown` | no live listing for that file's directory |

A live listing covers one directory, but produced files nest. The handler
therefore gathers listings for the root plus up to seven further distinct
parent directories of produced files (`PRODUCED_FILE_LISTING_MAX_DIRS = 8`),
dispatched concurrently, and resolves currency from their union. Produced files
in directories beyond that cap report `unknown`. Durability, the more important
signal, is unaffected by the cap.

Currency is the new information that makes one list possible. It is precisely
what a reader was previously extracting by eyeballing two lists side by side.

### What is not renamed

The stored record keeps every existing name: `kind: "workspace_file"`,
`index_workspace_artifact`, `is_workspace_artifact`, `workspace_artifacts`,
`artifact_index_item`, `GET /api/v1/tasks/{id}/artifacts`, and the session
artifact content routes. Threads share this record type and
`ArtifactViewerProvider` sits on top of it. The unification happens at
qualification and presentation. The user-facing word "artifact" disappears from
task surfaces, replaced by "Files"; it survives in code and in the thread
artifact viewer.

## The surface

One `TaskDrawerFiles` section replaces `TaskDrawerArtifacts` and
`TaskDrawerWorkspace`.

**Primary tier** — produced files, newest record per `workspaceRelativePath`,
each row carrying name and path, the producing run, durability, and currency.
The existing `allVersions` toggle survives unchanged as "show every version"
over the same list.

**Secondary tier** — live directory entries with no index record. Collapsed by
default, labeled as the directory rather than as output, rendered only when a
live listing succeeded. This is where an untouched checkout's files live, and
it preserves `TaskDrawerWorkspace`'s drill-down navigation for readers who
genuinely want to browse.

**Offline** — the primary tier renders in full; that is the point of
index-first. Currency shows `unknown` and the secondary tier collapses to one
line. The five failure states stop being top-level copy and become the reason
string on that line.

### Routines

A routine's Files surface is the same component with no special case. Rows come
from its occurrences' indexes — already how `newest_artifacts_by_file`
aggregates — with each row's run attribution naming the occurrence that
produced it. The live secondary tier at the routine root *is* the list of
occurrence directories, which is what a listing there returns. The
two-aggregation-axes defect dissolves rather than being fixed.

## Daemon changes

`packages/relay-daemon/src/generated-files.ts`:

- `listCandidates` stops filtering by extension for candidacy. It reports every
  changed file, still honoring `GENERATED_FILE_EXCLUDED_DIRS`, sibling agent
  homes (`isSiblingAgentHome`), `~$` temp files, symlinks, and
  `GENERATED_FILE_WALK_MAX_ENTRIES`.
- `GENERATED_FILE_LIMIT` rises from 20 to 200. Twenty was sized for documents
  and truncates immediately under "any changed file". The content budget is
  unchanged: `GENERATED_FILE_CONTENT_MAX_BYTES` 2 MB per file,
  `GENERATED_FILE_CONTENT_TOTAL_MAX_BYTES` 8 MB per event.
- Add lockfiles to the exclusion set (`package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`). The cap
  plus newest-first ordering is the backstop for remaining churn, not a filter.
- `isSensitiveCandidate` moves from gating *reporting* to gating *snapshotting*,
  with one exception: a file matching `SENSITIVE_FILE_NAME`, named `.env`, or
  starting with `.env.` is excluded outright rather than becoming a
  metadata-only row. "You have a `.env`" is not useful output and the name is
  itself a small leak.
- `DaemonGeneratedFile` gains `snapshotSkipped?: "too-large" |
  "not-snapshotable-type" | "sensitive"`, set wherever the daemon declines to
  attach `contentBase64`.

New capability `produced-files` in `DaemonNodeCapability`
(`packages/relay-core/src/daemon-node-protocol.ts`), advertised at
registration alongside `generated-files`. The backend uses it to know which
semantics a report carries; a daemon without it keeps the narrow
document-only behavior and its reports index exactly as they do today.

## Backend changes

`backend/relay/daemon_registry/artifacts.py`:

- Split `_is_generated_artifact_path` into two predicates:
  `is_produced_file_path(relative_path)` — permissive, decides candidacy — and
  `is_snapshotable_path(relative_path)` — today's allowlist logic verbatim,
  decides storage. The mirror-comment contract with `generated-files.ts` now
  covers two pairs of functions instead of one.
- `daemon_reported_generated_files` validates and passes through
  `snapshotSkipped`, and refuses to attach content for a path failing
  `is_snapshotable_path` even if the daemon sent `contentBase64` — the backend
  does not trust a daemon's storage decision.
- **Delete the dead fallback walk.** `_workspace_artifact_candidates`,
  `workspace_generated_files`, `workspace_generated_file_snapshot`, and
  `local_generated_file_item` have no callers anywhere in the backend or its
  tests; `registry.py` sets `items = []` for daemons that report nothing.
  `GENERATED_ARTIFACT_EXCLUDED_DIRS` and `GENERATED_ARTIFACT_WALK_MAX_ENTRIES`
  exist only to serve that walk and go with it. This also removes the
  shared-filesystem assumption CLAUDE.md still documents; update that
  paragraph.

`backend/relay/daemon_registry/registry.py` — the `run.completed` handler
carries `snapshotSkipped` onto the artifact dict it builds, alongside
`agentRunId`, `bytes`, `contentType`, and `workspaceRelativePath`.

`backend/relay/api/task_routes.py` — `GET /tasks/{id}/files` returns the merged
view: produced records from `newest_artifacts_by_file`, plus a live listing
when one is obtainable, plus a `liveStatus` describing why it was not. It
reuses `_task_workspace_target` and the existing workspace transport. The
existing `/tasks/{id}/artifacts` and `/tasks/{id}/workspace/files` routes stay
for now; the web app stops calling them.

Both `SessionStore` implementations (file-backed at `session_store.py:450` and
database-backed at `session_store.py:1636`) already pass the artifact dict
through opaquely, so `snapshotSkipped` needs no store change. No migration:
the field is additive and nullable.

## Testing

**Backend** (`backend/tests/api/test_task_artifacts.py`, plus a new
`test_task_files.py`)

- A non-allowlisted changed file (`src/main.py`) earns a row with
  `snapshotSkipped: "not-snapshotable-type"` and no stored content.
- A sensitive-named file (`.env.local`) earns no row at all.
- A daemon that sends `contentBase64` for a non-snapshotable path has that
  content discarded.
- A daemon without the `produced-files` capability indexes exactly as today.
- The merged `/files` response reports each currency state, including `unknown`
  when the live read fails.

**Daemon** (`packages/relay-daemon/tests/daemon.test.ts`)

- A run writing `main.py` reports it; a run writing `.env` does not.
- A run changing 200+ files respects both the row cap and the 8 MB content
  budget, and marks skipped rows with the right reason.
- Lockfile churn is excluded.

**Web** (new `web/tests/producedFiles.test.ts`)

- Each of the four currency states renders its own affordance, and a
  `snapshotSkipped` row is visibly distinct from a stored one.
- The offline path renders every produced row and collapses the secondary tier.
- The secondary tier lists only live entries absent from the produced set, so
  no file appears in both tiers.

## Out of scope

Deliberately excluded to keep this to one implementable change:

- Renaming the artifact record type or its routes.
- Any diffing or version-comparison UI beyond the existing `allVersions`
  toggle.
- Changes to `ArtifactViewerProvider` or thread artifact surfaces.
- Changes to `ProjectWorkspacePage` or project workspace semantics.
- Restructuring `TaskDrawer` itself. Editing and reviewing still share one
  scrolling form; that is a real problem and a separate design.

## Known risks

**The 200-row cap is a backstop, not a filter.** A run that regenerates a large
generated-code tree, or writes outside the excluded directories, will fill rows
with noise and truncate real output. Excluded dirs plus lockfile exclusion plus
newest-first ordering is the mitigation; if noise proves worse than expected in
practice, the next lever is honoring `.gitignore` when the workspace is a git
checkout, which was considered and deferred because a task workspace is often
not a repo and the rule would become two rules.

**The secondary tier may be unused.** It is the one piece of the old model
preserved. If produced-file coverage turns out to be complete in practice,
browsing a task directory has no remaining purpose and the tier can be dropped.
