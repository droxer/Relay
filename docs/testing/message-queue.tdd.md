# Message queue refinement

Journeys derive from the chat-input critique: understand interruption before
sending, read saved text without moving it, identify its recipient, recover a
removal, and receive localized recovery guidance.

## RED evidence

- `node --test web/tests/i18nQueueCopy.test.ts`: Traditional Chinese failed
  on `steer: Steer` and the untranslated accessible action label.
- `vitest run --configLoader runner interaction-tests/messageQueue.test.tsx`
  from `web/`: both tests failed because content was named only by ordinal
  and no Undo control existed.
- `pytest backend/tests/api/test_thread_queue.py -k remove_undo -q`: failed
  with `KeyError: 'removed'` because removal had no restoration record.
- The RED checkpoint commit was attempted, but the web typecheck hook rejected
  missing local `@tanstack/react-table` dependencies. No hook was bypassed.
  Existing dependencies were linked into this worktree for validation.

## GREEN evidence

| Guarantee | Tests | Result |
| --- | --- | --- |
| Expanding text leaves the queue intact; moving to draft is explicit | `web/interaction-tests/messageQueue.test.tsx` | PASS |
| Saved recipients and unavailable-recipient fallback are visible | Same component tests | PASS |
| Undo restores text, recipient, and relative position; retries do not duplicate | `backend/tests/api/test_thread_queue.py` | PASS |
| Full queues keep the restoration record for retry | Same backend tests | PASS |
| Transport failures map to localized messages rather than raw server text | `web/interaction-tests/threadQueue.test.tsx` | PASS |
| Both Chinese catalogs cover the queue labels and errors | `web/tests/i18nQueueCopy.test.ts` | 4 passed |
| Cross-client queue, safe preview, Undo, draft preservation, pause/resume | `web/e2e/threadQueue.spec.ts` | 6 passed: three locales × two themes, desktop and phone contexts |

Commands use the repository's installed Node/Vitest/Playwright and Python
environment; no dependency manifest or lockfile changed. Vitest uses
`--configLoader runner` because the worktree shares read-only installed modules.
The web export uses `next build --webpack`: default Turbopack cannot resolve
the shared dependency directory outside this worktree root.

- Focused React suite: 19 passed. Coverage for `MessageQueue.tsx` and
  `useThreadQueue.ts`: statements **90.32%**, branches **85.71%**, functions
  **95.83%**, lines **98.92%**. Command: `vitest run --configLoader runner
  --coverage --coverage.include=src/components/composer/MessageQueue.tsx
  --coverage.include=src/hooks/useThreadQueue.ts
  interaction-tests/messageQueue.test.tsx interaction-tests/threadQueue.test.tsx`.
- Full React suite at the first GREEN pass: **1,170 passed**. Later focused
  tests additionally exercise errors and controls.
- Backend queue, layering, and module-size tests: **21 passed**.
- Targeted Ruff, mypy, ESLint, Stylelint, and Impeccable detector: passed.
- Offline npm audit: zero reported vulnerabilities. Python audit could not
  run because `pip_audit` is absent from the installed environment.

Browser checks mock only API transport, using actual exported UI code. They
do not replace backend queue/authorization tests or prove real device
synchronization. Captures cover Chromium-emulated phone and desktop, not
physical devices or native screen-reader output.

## Broader validation

The complete compiled TypeScript suite reported **3,266 passed, one failed**.
The failure was the timing-sensitive `relay daemon keeps polling while
workspace.read acknowledgement stalls`; its isolated rerun passed. Command:
`node --test --test-timeout=60000 dist/packages/relay-core/tests/*.test.js
 dist/packages/relay-daemon/tests/*.test.js
 dist/packages/relay-supervisor/tests/*.test.js dist/web/tests/*.test.js`.

The full Python run reported **4,244 passed, 73 skipped, four failed and
19 setup errors**. All four failures and all 19 setup errors came from sandbox
restrictions on local sockets or `/dev/tty`, outside the queue changes. The
failed subset was rerun with local access enabled using `pytest backend/tests
--lf -q -n 2`: **23 passed**.

## Commit-hook environment

Initial commit attempts used global mypy 1.19 because this worktree had only
runtime dependencies installed. It reported missing library stubs and optional
value conversion errors outside the queue change. Installing the existing
locked dev extra with `uv sync --project backend --extra dev --offline` supplied
project mypy 2.4. `cd backend && uv run mypy` then passed for **466 source files**.
No dependency manifest, lockfile, or unrelated runtime code needed changing,
and no hook was bypassed.
