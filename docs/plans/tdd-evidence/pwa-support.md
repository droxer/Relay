# PWA support: TDD evidence

Journeys were derived from the request for installable desktop and mobile PWA
support. Users can install Relay, launch `/threads` in standalone mode, open an
offline deep link, and reconnect without losing its URL. Workspace data must
never be stored by the service worker.

## RED and GREEN

- RED: `npm run test:react -w web -- interaction-tests/pwa.test.tsx` failed because
  the specified public PWA registration module did not exist. The initial
  dependency/configuration error was resolved before recording this RED result.
  Checkpoint: `e0345e8f`.
- GREEN: the same target passes all 24 tests after implementation.
- Coverage: append `--coverage --coverage.include=src/lib/pwa.ts
  --coverage.include=src/lib/serviceWorker.ts` to that command. Registration and
  worker-source generation report 100% statements, branches, functions, and
  lines. The emitted worker executes separately in a VM; its lifecycle and fetch
  branches are behaviorally tested rather than included in this V8 percentage.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Manifest contains desktop/mobile PNGs and a separate maskable icon with matching dimensions | `interaction-tests/pwa.test.tsx` | PASS |
| Registration respects production, secure-context, and browser support gates; failure leaves the app usable | Same test file | PASS |
| Each build has its own offline cache; activation removes only obsolete Relay offline caches | Same test file | PASS |
| Navigations use the network and fall back only on network failures; HTTP errors remain visible | Same test file | PASS |
| API, media, assets, version checks, cross-origin requests, non-GET requests, and non-navigation fetches are not intercepted | Same test file | PASS |
| Production HTML advertises install metadata, icons are served, and the worker controls the page with only the offline document cached | `npm run test:pwa -w web` | PASS on desktop and mobile Chromium |
| Offline deep links retain path/query, retry works, reconnect reloads, and saved Chinese copy is respected | Same browser command | PASS; 6 total browser checks |
| PWA assets are public with correct MIME types, no-cache headers, and conditional 304 responses | `PYTHONPATH=backend /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m pytest backend/tests/api/test_url_contract.py -q` | PASS; 7 tests |

## Broader validation

- `npm run build -w web -- --webpack`: PASS, including static `/sw.js` export
  and Next TypeScript checks. The webpack flag accommodates this worktree's
  shared dependency symlinks; Turbopack refuses packages outside its root.
- `npm run test:react -w web`: 122 files, 731 tests PASS after resolving local
  dependencies. The first broad run used a second React copy in a temporary
  dependency install; that local setup was corrected before rerunning.
- `./node_modules/.bin/tsc -p packages/tsconfig.json`: PASS.
- ESLint on the changed application TypeScript files: PASS.
- `node deploy/tests/worker.mjs`: PASS.
- `node --test dist/web/tests/*.test.js`: 1,936 PASS, 4 FAIL. All four failures
  reproduce from a `git archive HEAD` baseline with the original source files:
  favicon light-mode contract, duplicate focus ring in admin users CSS,
  created-computer highlight contract, and routine duplicate-start contract.
- Offline screenshots inspected at 1280×900 and 390×844: no overflow and a
  visible retry action.
- `git diff --check`: PASS.

Native browser installation dialogs and physical iOS devices were not tested.
Only a generic offline page is available offline; workspace operations still
require connectivity. See [installation and hosting notes](../../pwa.md).
