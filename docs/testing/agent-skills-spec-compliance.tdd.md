# Agent Skills specification compliance — TDD evidence

Source: [Agent Skills specification](https://agentskills.io/specification).
The user journeys and guarantees below were derived for this change; no plan
file supplied them.

## User journeys

- As a skill publisher, I want invalid `SKILL.md` bundles rejected at publish
  time so every managed skill is portable across spec-compatible clients.
- As an agent operator, I want the delivered skill directory to match the
  frontmatter name so clients can discover the skill consistently.
- As a publisher of a colliding name, I want Relay to preserve both skills
  without rewriting either skill's spec-defined name.

## RED and GREEN evidence

| Guarantee | RED evidence | GREEN evidence |
| --- | --- | --- |
| Frontmatter enforces the standard name, description, optional-field, and metadata constraints | `pytest backend/tests/unit/test_skill_store.py -q`: 10 intended failures, including accepted overlong descriptions and invalid metadata | Same target: 41 passed |
| Collision paths preserve the declared name as the leaf directory | Same Python target: expected `bob/tools`, received `tools-bob` | Same target: collision assertions pass |
| Pi receives a named immutable view instead of a hash-named store directory | `node --test dist/packages/relay-daemon/tests/agent-skills.test.js`: expected `review`, received the manifest SHA-256 | Same target: 13 passed |
| A legacy nonconforming slug is not dispatched | `pytest backend/tests/unit/test_skill_bundle.py -q`: legacy suffix slug was delivered | Same target: 10 passed; the bundle is skipped as `invalid-bundle` |

## Broader verification

| What was checked | Command | Result |
| --- | --- | --- |
| Catalog, bundle resolution, publish API, and dispatch API | `pytest backend/tests/unit/test_skill_store.py backend/tests/unit/test_skill_bundle.py backend/tests/api/test_skill_routes.py backend/tests/api/test_skill_dispatch.py -q` | 74 passed |
| Entire Python backend | `pytest backend/tests -q` | 1,459 passed, 5 skipped |
| Daemon and core skill delivery | `node --test dist/packages/relay-daemon/tests/*.test.js dist/packages/relay-core/tests/skill-delivery.test.js` | 157 passed, 1 environment skip |
| React interactions | `npm run test:react -w web` | 56 passed |
| Python lint and diff hygiene | `ruff check ...` and `git diff --check` | passed |
| JavaScript dependency advisories | `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 0 vulnerabilities |

The broad compiled TypeScript run passed 1,471 of 1,472 tests. Its sole failure
is outside this change: `web/tests/paletteTokens.test.ts` reports the existing
`--font-app-cjk-sc` and `--font-app-cjk-tc` variables in
`web/src/styles/tokens/palette.css`. The production web build passed with the
webpack fallback. Turbopack could not bind its internal worker port on this
host (`EPERM`), so the normal `npm test` build stage could not complete.

## Security review and known gaps

- Upload request, per-file, revision, frontmatter, path, and file-count bounds
  remain in place.
- YAML uses `safe_load`; non-scalar required fields, unknown top-level fields,
  and invalid optional-field types are rejected without reflecting content.
- Materialized links remain constrained to validated cache/view roots and are
  checked against exact content digests and manifests.
- No authentication, authorization, query construction, secrets, dependency,
  or executable-bit behavior changed.
- The standard's guidance to keep `SKILL.md` under 500 lines and references
  shallow is advisory rather than a strict format constraint, so Relay does
  not reject bundles solely for those recommendations.
