# PR #729 CI outage fixture repair

The TypeScript/web CI job failed in `a proxy refusal during an outage is not a lease revocation`: the fake receiver counted two `run.completed` uploads rather than one accepted report.

The daemon uses at-least-once report delivery. Live delivery can race durable replay, and both copies carry the same report ID and digest. The backend's receipt store deduplicates them. The outage fixture previously appended every upload, unlike the real receiver.

## Regression

In an isolated checkout of PR head `525a164c`, delay the terminal acknowledgement by 250 ms and assert that recovery accepts one completion while receiving multiple uploads. With the original receiver, the focused regression fails with `2 !== 1`.

The fixture now records each report ID once, asserts that repeated IDs retain the same digest, and counts terminal uploads separately. The regression forces concurrent delivery and verifies one accepted completion. Runtime delivery behavior is unchanged.

## Validation

Validation runs against the isolated PR snapshot, excluding unrelated working-tree changes. Commands: `npx tsc -p packages/tsconfig.json`, the built TypeScript/web Node test suite, `npm run test:react -w web`, and the production dependency audit against registry.npmjs.org.
