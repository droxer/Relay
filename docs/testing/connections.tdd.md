# Connections implementation evidence

Source: [Connections design](../connections-design.md), expanded by the User's
explicit request for implementation and verification. Operational scope and
limitations are in [Connections setup](../connections.md).

## GitHub-only scope verification — 2026-11-06

The User narrowed the release to GitHub only. Gmail, Slack, and Google Drive
are unavailable. Their adapters and picker copy have been removed. Historical
records are hidden and cannot authorize, obtain tokens, or receive new Grants;
owner cleanup still removes their encrypted secrets.

- RED: `uv run --project backend --extra dev pytest backend/tests/unit/test_connection_providers.py -q`
  returned **3 failed, 3 passed** because the catalog still offered other providers.
  Checkpoint: `1bb7b00c`.
- GREEN: the provider, service, and API suites returned **33 passed** after the
  implementation change. Checkpoint: `fa0538cc`.
- Added stored-record cleanup regressions for all three excluded providers.
  `uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_connection_service.py backend/tests/unit/test_connection_providers.py backend/tests/api/test_connections.py --cov=relay.connections --cov=relay.core.connections --cov=relay.persistence.connection --cov-report=term-missing -q`
  returned **36 passed**, **88% statement coverage** across those modules.
- Layering, module size, and route-auth suites returned **11 passed**.
- `npm run test:react -w web -- interaction-tests/connections.test.tsx` returned
  **4 passed**.
- `npx playwright test -c playwright.recovery.config.ts connections.spec.ts githubConnection.spec.ts --workers=2`
  from `web/` returned **11 passed**, covering desktop, mobile, Chinese,
  disconnect, initial Thread/Task/Automation Grants, and public GitHub imports.
- `npm run build -w web` passed. Commit hooks passed backend lint/typecheck and
  web typecheck/ESLint. `git diff --check` passed.

Provider calls use mocked HTTP transports; a real GitHub OAuth account was not
used. The complete-suite counts below are historical evidence from the broader
implementation before this scope reduction.

## Journeys and guarantees

| Journey | Evidence |
| --- | --- |
| Authenticate a service and retain the right external identity | Provider HTTP transport tests for GitHub; session-bound single-use state; consent-scope validation; reconnect identity checks |
| Give a new Thread, Task, or Automation bounded access | API tests verify initial save before command delivery; browser tests inspect each initial submission's explicit resource/action Grants |
| Use services during execution | Backend broker test executes a granted GitHub read through JSON-RPC under an actual database command lease; core test launches the real stdio proxy against a local HTTP server |
| Keep automated runs bounded | Occurrence creation copies Grants in its transaction; generated Tasks cannot edit them; unavailable access pauses before firing and prevents Resume |
| Stop access and prevent it from returning unexpectedly | Disconnect tests, late-provider-error test, real threaded reconnect/disconnect interleaving, normal/inherited narrow-then-expand tests, stale-revision tests, two-message Composer test |
| Preserve existing workflows | Full suites plus public GitHub importer browser flows, route-auth, layering, schema-drift, and runtime command compatibility tests |

## RED/GREEN checkpoints

| Behavior | RED evidence | GREEN evidence / checkpoints |
| --- | --- | --- |
| Encrypted lifecycle and work Grants | `test_connections.py` initially failed on the missing Connections module | Renamed to `test_connection_service.py`; `8ae0c89d` → `fca062a4` |
| Signed-in owner-scoped API | Four API tests returned 404 for missing routes | `9153fad8` → `b3946772` |
| Occurrence snapshots and delivery | Missing inherited Grants and missing `for_work` implementation | `a1578064` → `e34539a8` |
| Run-bounded service broker | Valid dispatched command reached a missing endpoint: 404 instead of lease rejection | `be00bf98` → `7431e65b`; an earlier fixture error was corrected before this valid RED |
| Runtime tools | Missing module compile-time RED, then compiled command lacked MCP configuration | `6991fc8d` → `f525eddc`; real stdio exchange passes |
| Settings and resource picker | Missing component imports, then explicit selection/resource behavior | `1c400822` → `1ce62b39` |
| Initial work dispatch | New Tasks/Threads had zero Grants after creation | `d88d1a95` → `feb9df36` |
| Provider failures | Expired refresh mapped incorrectly; insufficient consent appeared connected | `0ecc92ee` → `30481c2b` |
| Automation preflight and deletion | Unavailable Connection still created an occurrence; cleanup method missing | `0094c087` → `39683352` |
| Inherited picker controls | Custom checkbox still emitted changes inside a disabled fieldset | `c14c30d2` → `5fbc724d`; explicit disabled props and read-only UI guard; regression and full React suite pass |
| Revocation races and stale drafts | Reconnect restored disconnected credentials; old runs regained removed access; stale edits succeeded; second message saved old access again | `c7a20912` → `1ce62b39` |

The independent review initially returned **fix** for three material permission
findings. After the regression tests and fixes, it scored all three **resolved**
and returned **ship at the scope of those findings**. The configured reviewer
role could not start because its pinned model was unavailable; a fresh-context
default agent performed the review. It did not edit files or claim to run tests.

## Verification

Commands were run from the repository root except Playwright, run from `web/`.

| Command | Observed result |
| --- | --- |
| `uv run --project backend --extra dev pytest -q` | 3,649 passed; 10 skipped |
| `npx tsc -p packages/tsconfig.json` | Passed |
| `node --test dist/packages/relay-core/tests/*.test.js dist/packages/relay-daemon/tests/*.test.js dist/packages/relay-supervisor/tests/*.test.js dist/web/tests/*.test.js` | 2,936 passed |
| `npm run test:react -w web` | 825 passed across 141 files |
| `npx playwright test -c playwright.recovery.config.ts connections.spec.ts githubConnection.spec.ts --workers=2` | 11 passed |
| `npm run build` | Passed; core, daemon, supervisor, installer bundle, production web export, and built test compilation |
| `uv run --project backend --extra dev ruff check backend` | Passed |
| `cd backend && uv run mypy` | Zero errors |
| Pre-commit gates | Python AST/lint/types, package/web types, web styles/lint, whitespace, conflict and secret checks passed |
| `npm audit --registry=https://registry.npmjs.org --audit-level=high` | Zero vulnerabilities; explicit registry used because the configured mirror has no audit endpoint |
| `uv run --with pip-audit pip-audit --path backend/.venv/lib/python3.14/site-packages` | No known vulnerabilities; local unpublished `relay` package cannot be audited against PyPI |
| Impeccable detector on the new Settings/picker/CSS files | No findings |
| `git diff --check` | Passed |

Connection-specific coverage command:

```sh
uv run --project backend --extra dev --with pytest-cov pytest \
  backend/tests/api/test_connections.py \
  backend/tests/unit/test_connection_service.py \
  backend/tests/unit/test_connection_providers.py \
  --cov=relay.connections --cov=relay.core.connections \
  --cov=relay.persistence.connection --cov=relay.api.connections \
  --cov-report=term-missing -q
```

Result: **32 passed, 89% statement coverage** over the new backend Connection
modules (619 statements; 67 uncovered). This is not a claim about whole-repo or
frontend coverage. Uncovered paths include some refresh, malformed provider,
and failure/recovery variants; ownership and the reviewed revocation races have
explicit tests.

## Browser and operational limits

Browser tests verify Settings in desktop/light, mobile/dark, and Chinese/mobile
layouts, disconnect impact, provider navigation, all three initial work
submissions, and anonymous public GitHub imports. Screenshots were inspected at
`.impeccable/review/connections-desktop.png`, `connections-mobile.png`, and
`connections-chinese.png`; the independent reviewer found no material visual
defect in those captures. A separate read-only documentation comparison confirmed
that no new global design-system decision was introduced. Provider identities
in browser fixtures are test data.

The first broad Python run found an outdated dynamic fingerprint-test exclusion
and a PostgreSQL concurrency timeout. The exclusion now accounts for the new
optional intent field while preserving the legacy hash; the concurrency case
passed a focused rerun and the next complete run (3,645 passed, 10 skipped).
The final full rerun includes the additional review regressions: 3,649 passed, 10 skipped. The first
TypeScript run caught a missing English singular form; it was corrected, and
the full rerun passed. Initial browser fixture failures were corrected to return
the real schedule-preview shape and use the actual Send label.

No real provider account was authorized, no OAuth credentials or production
configuration were changed, and no deployment/push was performed. Live provider
smoke tests require the operator's OAuth applications and consent setup. Native
service-event subscriptions and provider-side revocation jobs remain outside
the implemented first-release capability; existing Automation triggers can
already use the Connections tools.

## PR integration with main — 2026-11-06

Integrated main at `6b19890a` before opening the PR. Resolved shared API docs,
capability declarations, browser test registration, and English/Chinese locale
additions while retaining both features. Renumbered the Connections migration
to `20261106_0114`, following main's project-manager revision `20261106_0113`.

- Connections service/provider/API, project-manager API, schema drift, layering,
  and route-auth suites: **77 passed**. PostgreSQL migration checks include the
  newly sequenced migration.
- `npm run build`: passed. After correcting locale merge omissions caught by
  the GitHub importer browser tests, `npm run build -w web` passed again.
- Connections, project-manager, and GitHub importer React suites: **8 passed**.
- Connections, GitHub importer, and project-manager browser suites: **14 passed**.
- Built Connection proxy and project-manager core/daemon suites: **6 passed**.
- npm and Python dependency audits: no known vulnerabilities; the unpublished
  local Python `relay` package is excluded from PyPI auditing.

These are focused integration results; the complete-suite results above were
not rerun after merging main. No live OAuth account or production deployment was
used for these checks.
