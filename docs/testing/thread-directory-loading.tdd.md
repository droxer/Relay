# Thread directory loading render loop

Journeys were derived from the reported thread-page crash: open a thread and
filter the directory when local computer discovery is disabled, pending, or
failed. Loaded computer runs must still update the directory, and a failed
refresh must retain the last known runs.

## Cause and change

`useLocalDaemonNodes` returned `query.data ?? []`. Before discovery produced
data, every render created a new array. App's memoized node merges therefore
changed, invalidating `useThreadDirectory`'s candidates. Its render-time state
update repeated indefinitely because the next render received another array.
A module-level empty array keeps the unloaded query result stable.

## Red and green evidence

- RED checkpoint: `78c374dc`. `npm run test:react -w web --
  interaction-tests/threadDirectoryLoading.test.tsx` executed three regressions;
  all failed with `Too many re-renders. React limits the number of renders to
  prevent an infinite loop.`
- GREEN checkpoint: `4b6bb3d6`. The identical command passed all three tests after
  stabilizing the fallback. The final test file adds discovered-run and failed
  refresh coverage; all four tests pass.

| Guarantee | Test in `web/interaction-tests/threadDirectoryLoading.test.tsx` | Type | Result |
| --- | --- | --- | --- |
| Disabled discovery permits directory rendering and filtering | renders and filters threads when local-node discovery is disabled | Hook integration | PASS |
| Pending discovery permits directory rendering and filtering | renders and filters threads while local-node discovery is pending | Hook integration | PASS |
| Failed discovery leaves the directory usable | keeps the directory usable after local-node discovery fails | Hook integration | PASS |
| Discovered runs update rows; a failed refresh retains them | applies discovered runs and keeps them visible if a later refresh fails | Hook integration | PASS |

The tests exercise the actual query, node-merge, and directory hooks in App's
composition. They intercept discovery requests and do not require a backend.

## Verification and limits

- Webpack production build and web TypeScript check: `npm exec -- next build
  --webpack` from `web/` passed.
- Package TypeScript check: `npx tsc -p packages/tsconfig.json` passed.
- All 1,827 compiled package/web unit tests passed with local port/process
  access. The restricted run had three environment-related failures.
- Focused ESLint check for `src/hooks/useLocalDaemonNodes.ts` passed.
- Focused V8 coverage: `npm run test:react -w web --
  interaction-tests/threadDirectoryLoading.test.tsx --coverage
  --coverage.include=src/hooks/useLocalDaemonNodes.ts` measured 100% statements,
  lines, and functions, and 75% branches. Its coverage threshold exits nonzero:
  the untested branch is the defensive `fetchQuery(...) ?? []` fallback; the
  real query function already always returns an array.
- `npm test` stopped in Turbopack because its worker could not bind a port;
  the suites were run separately with the Webpack build above.
- Dependency audit found four existing advisories (one high, two moderate,
  one low). No dependency versions changed.
