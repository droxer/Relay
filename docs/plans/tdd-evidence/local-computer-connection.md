# Local Computer connection and recovery

Scope: browser-approved local enrollment, explicit runtime inventory refresh,
and durable agent output delivery. Existing scoped-token installation remains
available. Agent execution stays on daemons.

## Behavior and checkpoints

| Behavior | RED checkpoint / evidence | GREEN evidence |
| --- | --- | --- |
| Refresh runtime inventory on request, only when idle | `14ee23a3`: missing API returned 404, daemon probe count stayed 1, UI control absent | `886e6b64`: owned refresh command, capability gate, lease-matched acknowledgment, UI polling; API/daemon/UI tests |
| Recover output after process restart and HTTP failures | `36b83824`: output did not survive restart; ordering regression tests | `7f580fe9`: private fsynced outbox, ordered replay, terminal delivery despite failed output, backend lease checks and sequence deduplication |
| Approve local Computer connection in browser | `0ac2ae8e`: missing authorization API and device setup module | Device API tests, actual packaged installer test, React consent test and Playwright consent journey |
| Keep approval code through route normalization | Playwright initially landed on Computer settings without approval; route regression test added | Legacy `/computer` redirects preserve the code; canonical `/settings/computers` supports approval and pagination |

## Validation

- Full `npm test`: builds all packages, downloadable installer and Next.js,
  then runs compiled TypeScript, React interactions and Python tests.
- Packaged installer and durable outbox focused run: 9 passed. Installer tests
  use isolated homes, fake service commands and a local HTTP fixture; they do
  not install a service on the developer's computer.
- Authorization API: 2 passed (explicit authenticated approval, invalid secret,
  single redemption, repeated approval and expiration).
- Installer shell tests: 9 passed, including the legacy token prompt through a
  controlling terminal with piped stdin.
- Playwright: 1 passed, explicit consent required, local path visible, approval
  query preserved through legacy route normalization. Uses mocked HTTP APIs.
- Node coverage for device setup + durable outbox: 92.72% lines, 80.68% branches,
  90.48% functions. Individual line coverage: device setup 87.23%, outbox 94.34%.
  This is focused coverage, not a claim of repository-wide coverage.
- `npm audit --registry=https://registry.npmjs.org`: 0 vulnerabilities.
  The configured mirror lacks the audit endpoint, so the official registry was
  used without changing user configuration.

## Deployment and limits

Apply migration `20260920_0078` before deploying the new backend. It adds the
short-lived authorization grant table; only hashes of device polling secrets
are stored. Browser approval links expire after ten minutes. Token exchange is
single-use; interrupted setup after redemption requires starting setup again.

Manual runtime refresh waits until active runs finish. Existing daemons without
that capability remain usable but need updating to expose the refresh action.
Output storage is bounded at 64 MiB / 4096 records; exhausted storage fails the
run rather than silently claiming complete output. Terminal evidence can still
be persisted and delivered. Recovery does not restart completed agent work.

No production deployment, remote write, or real local daemon installation was
performed. Browser E2E validates UI behavior with mocked APIs; the separate
packaged installer and backend tests validate the protocol boundaries.
