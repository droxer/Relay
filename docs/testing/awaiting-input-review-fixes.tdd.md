# Awaiting-input review fixes

Journeys were derived from the three review findings: retry a rejected choice,
read a request for multiple details without turning its fields into answers,
and retain every item of a question with more than six list entries.

## Changes and regression evidence

| Guarantee | Test target | Before fix | After fix |
| --- | --- | --- | --- |
| Rejected dispatch re-enables choices and custom replies; the same answer can be retried | `web/interaction-tests/awaitingInput.test.tsx` | Failed: buttons stayed disabled | Passed |
| Local mention validation and thrown dispatch errors release the prompt | `web/interaction-tests/awaitingInput.test.tsx` | Both failed: buttons stayed disabled | Both passed |
| Unstructured lists retain their complete question and produce no answer buttons | `web/tests/awaitingInput.test.ts` | Three failures, including a seven-item list | All passed |

`ComposerHandle.send` now returns the dispatch result after the composer has
adopted the answer. The prompt unlocks on rejection. Structured `inputOptions`
still produce buttons; list parsing from question prose has been removed.

Commands executed:

- `npx tsc -p packages/tsconfig.json`
- `node --test dist/web/tests/awaitingInput.test.js dist/web/tests/composerTarget.test.js`: 33 passed.
- `npm run test:react -w web -- interaction-tests/awaitingInput.test.tsx interaction-tests/composerMention.test.tsx`: 7 passed.
- `npx tsc --noEmit -p web/tsconfig.json`: passed.
- `npm run build -w web -- --webpack`: passed. Default Turbopack build failed because the sandbox disallowed port binding.
- From `web/`, `npx playwright test -c playwright.recovery.config.ts awaitingInput.spec.ts`: 11 passed.
- `node --experimental-test-coverage --test-coverage-include='dist/web/src/lib/awaitingInput.js' --test dist/web/tests/awaitingInput.test.js`: 100% lines/functions, 92.31% branches. Component coverage was not measured.

The full compiled Node suite reported 1928 passed and two unrelated failures in
`designGrid` and `projectPage`; their implementation files are unchanged.
The React suite reported 424 passed and the previously reported `rosterTabs`
timeout. Rerunning that file alone passed all four tests.

RED/GREEN evidence was captured before committing and is recorded here.
This change follows the human-input guidance shipped in PR #376.

The full Python run reported 2227 passed, 16 skipped, and two installer failures
caused by sandbox denial of `/dev/tty`. Rerunning those two tests outside the
sandbox passed both (`uv run --project backend --extra dev pytest
backend/tests/api/test_computer_installer.py -k 'prompt_uses_controlling_tty' -q`).
PostgreSQL schema-drift tests were skipped in this environment.
`git diff --check` passed after the fixes.
