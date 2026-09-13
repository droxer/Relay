# Share skills implementation progress

Source: [design](share-skills-design.md), [plan](share-skills-plan.md).
Resumed from `bbc72911` on 2026-09-14 in the existing feature worktree.
The prior provider transcript is historical and has not been modified.

## Corrections discovered during implementation

- **Codex supports skills.** The plan's conclusion from the absence of a
  top-level `skills` CLI subcommand is incorrect. Official documentation:
  https://learn.chatgpt.com/docs/build-skills (read 2026-09-14), including
  local discovery and `/skills`. Preserve existing inventory support.
  Verify delivery isolation separately before deciding the registry entry;
  do not ship copy claiming that Codex lacks skills.
- **Kimi paths:** Relay already sets `KIMI_CODE_HOME` to `.kimi-code`.
  Align inventory, host provisioning, and guest provisioning with that home.
  Test the executed inventory sweep with a temporary home, not only constants.
- **Catalog persistence:** include an authoritative event table and replay
  path, plus content-addressed blobs. The original migration list omitted
  events despite requiring event sourcing. Validate migrations against a
  disposable database, not the operator's configured database.
- **Catalog validation:** validate frontmatter, names, namespace and paths;
  reject duplicate and file/directory-conflicting paths. Enforce live-name
  uniqueness even when namespace is absent. Database constraints and locking
  must handle concurrent revision and slug allocation.
- **Routes:** wire through the existing canonical API router groups; unprefixed
  daemon URLs in the plan are shorthand for `/api/v1/...`.
- **Delivery:** host filesystem writes alone cannot materialize into BoxLite.
  The execution-environment seam must support both sandbox modes. Empty managed
  grants must not fall back to stale grants. Shared mutable config directories
  do not preserve different revisions of the same slug across concurrent runs;
  use immutable run/manifest-specific delivery views or an equivalent proven
  lifetime mechanism.
- **Import:** validate the actual download peer, redirects, and archive byte
  limits. Resolving a hostname before a second independent connection is not
  sufficient protection against DNS rebinding.
- **UI:** implementation must include publish/upload/import and API transport,
  query invalidation, route registration, and real component tests. The plan's
  undefined rendering helpers are examples, not executable regression tests.

## Task state

| Task | State |
| --- | --- |
| 1 — Kimi inventory/provisioning | Complete; preserve Codex support; review approved |
| 2 — catalog store/migration | In progress |
| 3 — catalog HTTP | In progress; RED verified (11 expected 404 failures) |
| 4 — fenced import | Pending |
| 5–6 — grants and agent view | Pending |
| 7–10 — protocol, delivery, notices | Pending; CLI isolation verification required |
| 11–12 — library and share UI | Pending |

## Validation evidence

Task 1:

- RED: `npx tsc -p packages/tsconfig.json` then
  `node --test --test-name-pattern='agent skills are provisioned|discoverAgentInventory scans live' dist/packages/relay-daemon/tests/daemon.test.js`:
  2 intended failures (old Kimi paths).
- GREEN: same focused tests, 2 passed; full daemon test file, 87 passed.
- `make build-packages` passed; `git diff --check` passed.
- Read-only review approved runtime and tests. Documentation supersession notes
  address the review's warning about later tasks removing Codex support.
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
  The configured mirror lacks an audit endpoint; the override changed no config.

No feature completion or real-node isolation claim has been made.
