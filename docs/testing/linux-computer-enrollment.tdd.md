# Linux Computer enrollment fixes

The spec comes from the two defects reproduced in this session:

1. Connecting another host with the same workspace path must not reuse the first
   host's Daemon Node or revoke its runtime credential.
2. A computer-limit conflict must remain a failed browser approval; only a grant
   verified as approved or consumed can turn a 409 into success.

A User must also be able to reauthorize the same host at the computer limit after
backend restart. Older installers without host identity must still enroll safely.

## RED evidence

- `PYTHONPATH=backend <backend-venv>/bin/pytest backend/tests/api/test_device_enrollment_identity.py -q`:
  9 failed, 1 passed. Different hosts reused the same node, the limit was bypassed,
  and invalid identities were accepted.
- `node_modules/.bin/vitest run --root web interaction-tests/deviceApproval.test.tsx`:
  2 failed, 7 passed. Limit conflicts and failed conflict verification displayed
  successful approval.
- `node --test dist/packages/relay-daemon/tests/device-setup.test.js`:
  1 failed, 3 passed. The host identity was absent from the authorization request.
- Regression checkpoint: `9ee10fe3`.

`<backend-venv>` was `/Users/feihe/Workspace/Relay/backend/.venv`, an existing local
Python environment; dependencies were reused locally without changing manifests.

## Implementation

The installer resolves its stable host identity before requesting browser
approval and pins it in the service arguments. The grant persists that identity
in a new nullable `computer_authorizations.workspace_id` column (Alembic
`20261102_0106`). Node reuse and durable claims include host identity. Older
browser installers without identity use a per-authorization claim instead of
adopting another host by path. Legacy manual enrollment retains its existing API.

The browser verifies grant status after 409 and displays the backend's limit
error when the request remains pending. Failure to verify does not imply approval.

## GREEN evidence

| Guarantee | Test area | Result |
| --- | --- | --- |
| Another host cannot revoke a pending or registered host, including an older installer | `backend/tests/api/test_device_enrollment_identity.py` | PASS |
| Reauthorization survives restart at the limit; another host cannot bypass that limit | same API tests | PASS |
| Invalid identity input is rejected | same API tests | PASS |
| Host-scoped claims distinguish users, hosts, and legacy claims | `backend/tests/unit/test_computer_identity.py` | PASS |
| Pending grants survive migration upgrade and downgrade | `backend/tests/unit/test_computer_authorization_identity_migration.py` | PASS |
| A limit conflict or failed status verification cannot show approval | `web/interaction-tests/deviceApproval.test.tsx` | 9 passed |
| Identity is transmitted to approval | `packages/relay-daemon/tests/device-setup.test.ts` | 4 passed |

The focused backend run covering enrollment identity, computer limits, daemon API,
computer identity, layering, and module sizes passed 150 tests. The shell installer
suite passed all 24 tests with temporary-terminal access. The daemon setup,
installer-host, and installed-computer suites passed 40 tests. The packaged-client
installer integration passed all 5 tests using a local fake backend and service
commands.

Browser coverage for `DeviceApproval.tsx`: 93.18% statements and branches, 100%
functions, 95.23% lines (`vitest run --root web interaction-tests/deviceApproval.test.tsx
--coverage --coverage.include=src/components/computer/DeviceApproval.tsx`).

Backend mypy passed all 387 source files; Ruff, package and web TypeScript checks,
and `git diff --check` passed. `npm audit --omit=dev --audit-level=high --offline`
reported zero vulnerabilities using cached advisory data.

## Limits

No live Linux systemd installation was performed. Installer integration uses fake
service commands on the current macOS host. Backend coverage tooling is absent
from the reused environment, so no backend coverage percentage is claimed.
Deploy the new database migration before serving the updated backend; rebuild
the computer bundle for distribution. No external deployment or push was made.

## Full verification and review

The user selected `9bc498e5678696b4945ee09072db685c5cb71f34` as the review
baseline. Independent Standards and Spec reviews of the fix found no documented
standard violations or actionable Spec defects. Standards recorded one optional
Duplication smell: the adoption condition is repeated in enrollment admission and
registry provisioning.

`npm test` built the production web export and passed all 2,871 Node tests. The
React suite passed 745 tests and timed out on the unchanged composer roster
keyboard test (`rosterTabs.test.tsx`); the timeout reproduced in isolation.
`make test-e2e` passed 103 tests, including computer approval and every performance
budget, and failed on the unchanged roster availability chip and team
responsibility editing surfaces.

The complete Python suite was exercised in four file shards with
`PYTHONPATH=backend` and the existing development environment. An initial shard
exhausted its file-descriptor limit; it completed after raising that process's
limit. The completed shards reported 3,370 passes, 10 skips, and two failures:

- The real Postgres backup test overlapped schema-changing tests. It passed in
  isolation once those tests finished.
- The existing concurrent enrollment test replaced `find_by_user` with a shim
  that did not accept its new `workspace_id` keyword. Updating the shim and
  parametrizing both legacy and identified hosts fixed it; the entire registry
  test module then passed all 272 tests (including the new parameter case).

No production changes followed the independent review; the follow-up only updates
that concurrency regression and this evidence. Repository hooks passed for the
fix using the existing development environment without syncing its dependencies.

Before opening the PR, merged `origin/main` at `5cf8ff5c` (native Windows
execution and task review briefs). The merge was conflict-free. Recompiled the
core and daemon packages and TypeScript tests, then reran the affected checks:
23 backend enrollment/identity/migration tests, 24 daemon installer/device-setup/
native-Windows tests, and all 9 approval interaction tests passed. Rebuilt the
installer bundle from the integrated sources.
