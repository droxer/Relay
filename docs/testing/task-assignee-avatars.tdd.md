# Agent avatars on task and routine pages

Task cards, task rows, and routine rows now receive the assigned agent's saved
profile image from the agent roster. Team assignments use the team's profile
image. The shared badge renders an avatar even when only the logical agent ID
is present, and uses its existing identity fallback when no image is available.
Visible assignee names and readiness indicators are retained.

## Evidence

- RED checkpoint `ce93bcd0`: six new rendering cases failed because the image
  was absent across all three surfaces, with and without a recorded executor.
- GREEN: 23 focused rendering cases pass, including team images and fallback
  avatars for missing roster entries and legacy executor-only assignments.
- Focused command: `npm run test:react -w web -- --run interaction-tests/taskAssignee.test.tsx`.
- Component coverage: 100% statements/functions/lines, 96% branches, using the
  focused command with `--coverage --coverage.include=src/components/TaskAssignee.tsx`.
- Full React suite: 36 files, 226 tests passed before the final extra team-image
  test; the final focused run includes that test and the fallback assertions.
- `npm test`: production build and TypeScript compilation passed; 1,701 Node
  tests passed, with the previously observed live Kimi inventory failure.
- `npm audit`: the configured npmmirror registry does not implement its advisory endpoint.
- `git diff --check` passed. The pre-existing `web/next-env.d.ts` change was preserved.

No backend, persistence, or agent assignment behavior changed.
