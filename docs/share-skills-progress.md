# Share skills implementation progress

Source: [design](share-skills-design.md), [plan](share-skills-plan.md).
Resumed from `bbc72911` on 2026-09-14 in the existing feature worktree.
The prior provider transcript is historical and has not been modified.

## Corrections discovered during implementation

- **Codex supports skills.** The plan's conclusion from the absence of a
  top-level `skills` CLI subcommand is incorrect. Official documentation:
  https://learn.chatgpt.com/docs/build-skills (read 2026-09-14), including
  local discovery and `/skills`. Preserve existing inventory support.
  Codex is included through an isolated `CODEX_HOME` managed-skills view.
  Project/admin discovery remains additive; the UI makes no complete allowlist claim.
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
| 2 — catalog store/migration | Implemented; PostgreSQL schema drift checks passed |
| 3 — catalog HTTP | Implemented; ownership, validation, and dispatch integration tested |
| 4 — fenced import | Implemented; 38 focused tests passed, including DNS/header deadlines |
| 5–6 — grants and agent view | Implemented; creation/patch bypasses blocked and reviewed |
| 7–10 — protocol, delivery, notices | Implemented; daemon hardening reviewed and approved |
| 11–12 — library and share UI | Implemented; browser fixtures, shared dialogs, and full web contracts passed |

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

Automated implementation checks and deployed-node acceptance are tracked separately below.

## Integration decisions and review fixes

- Only an explicitly versioned managed policy enables managed delivery. Default
  `{}` policies remain unmanaged; revoking the final grant retains a v1 empty
  grant set. Generic creation and patch cannot inject grants.
- Pi's installed resource loader confirms explicit `--skill` paths survive
  `--no-skills`. Kimi uses a parent directory containing the granted skills and
  must receive an actual empty parent even for an empty managed set.
- The daemon capability allowlist includes `agent-skills`. Dispatch removes the
  obsolete blanket skill-policy rejection. Older daemons produce a persisted,
  visible notice without depending on a new execution-start event.
- Authenticated download is scoped to the node, active command, and its captured
  manifest. An API regression publishes and grants to one of two Claude agents
  on the same node and checks the other command has no grant or blob access.
- Canonical metadata imports the skill tables. Five disposable PostgreSQL schema
  tests passed, including migration-to-metadata comparison.
- Import validation pins a public download address, refuses redirects, bounds
  compressed and expanded bytes, and includes DNS plus trickling headers in the
  absolute timeout. DNS worker count is bounded.
- YAML frontmatter supports normal nested metadata and folded descriptions;
  direct PyYAML dependency is recorded in the lockfile.
- `npm audit` and `pip-audit` reported no known vulnerabilities.

## Acceptance and known limits

- Desktop (1440×960) and mobile (390×844) browser checks passed using
  intercepted read fixtures in an isolated frontend process. No server was
  seeded. Mutation flows are covered by component interaction tests.
- Deployed-node Claude discovery isolation remains unverified. A safe local
  probe used the compiled materializer to create separate granted and empty
  views, then initialized Claude 2.1.236 with temporary homes and `--bare`. Both
  initializations succeeded without credentials or model prompts, but neither
  response enumerated the test skill. This is not positive discovery evidence.
- Skills workflow body copy is English; navigation labels exist in all three
  shipped locales.

### Final-review evidence

- Daemon re-review approved bounded transfer, digest/exact-tree validation,
  file CAS reuse, atomic concurrent publication, guest execution, and safe empty
  views. Thirteen focused materializer tests and 87 daemon tests passed.
- Kimi's installed loader scans immediate children. Namespaced grants therefore
  supply their immediate parent directories, not only the top skills directory.
  A regression models that real discovery behavior.
- Skip-event parsing follows the shared optional-slug contract. It permits more
  than 100 entries (there is no 100-grant quota), and persistence accepts at most
  one report per authorized command skill. Optional absent slugs are resolved
  from the issuing manifest; forged slugs are ignored.
- Full-suite checks exposed the nullable unmanaged bundle in the agent view;
  corrected it and reran the team suite: 74 passed.
- Catalog path and slug limits are 512 characters; file components are at most
  255. Three previously accepted invalid cases failed in RED and pass in GREEN.
- Pre-commit checks passed, including lockfile consistency, both TypeScript
  projects, and CSS lint. Full tests additionally enforce shared dialogs and
  design-token usage; all six failures were corrected without weakening the existing contracts.
  The full compiled web suite passed 1,089 tests and Vitest passed 43 tests.

- Kimi duplicate frontmatter names are resolved deterministically by `(slug,
  skillId)`; later conflicts are reported as `name-conflict`. This reflects the
  native CLI's name-based indexing without rewriting immutable revision content.
- The first complete Python run had 1,452 passes and one obsolete exact-payload
  expectation: node-installed inventory now includes `source: "node"`. That
  assertion was updated, and all 50 agent API tests passed. The final full run is recorded below.

## Local commits

- `e1d83a9c` — Kimi inventory and provisioning paths.
- `a96fd6ee` — catalog, immutable revisions, import, grants, dispatch, and notices.
- `f339b2ec` — shared protocol and isolated daemon delivery.
- `de16d017` — library, share drawer, agent controls, and UI regression coverage.

No changes were pushed, deployed, or applied to the operator's database. The
new schema was exercised only through disposable test databases/schemas.

## Final verification

Both scripts composing `npm test` passed against the final implementation:

- `npm run test:ts`: production build, 1,468 compiled TypeScript tests, and
  43 React interaction tests passed.
- `npm run test:py`: 1,455 Python tests passed, including PostgreSQL migration
  and schema comparison checks. Four existing dependency deprecation warnings
  remain (Starlette/httpx and SQLite datetime adapters).
- Pre-commit hooks passed for all implementation commits; `git diff --check`
  passed. Dependency audits found no known vulnerabilities.

All 12 implementation tasks are complete. The deployed-node discovery acceptance
check and translation limitation above remain explicitly open; automated and
initialization-only probes do not substitute for that discovery check.
