# Direct delegation verification

## Intent

An individual Logical Agent may yield a bounded contribution to another
explicitly permitted, owned Agent on the same Computer, then receive the result
and retain responsibility for the original request. No Team is required.

## RED and GREEN

Journeys were derived from the requested A → B → A flow. The initial unit
target had 12 failures: delegation reports were discarded, invalid requests
were accepted, permissions could not be persisted, and child failures did not
return control. The initial API target had four failures for the unsupported
permission field. These tests were preserved in checkpoint `fea90579`.

The same targets passed after implementation. Additional regression tests
captured and then verified bounded refusal recovery and a target becoming
unavailable after manifest persistence but before delivery.

| Guarantee | Evidence |
| --- | --- |
| Permission settings persist and are default-deny | `backend/tests/unit/test_direct_delegation.py` |
| Self, missing, foreign and cross-Computer grants are rejected; another User cannot edit grants | `backend/tests/api/test_direct_delegation_api.py` |
| A → B → A shares one Thread and workspace | API flow tests with real database stores and daemon command/event handling |
| Delegate success, blocker, runtime failure and confirmed non-delivery return control | API and pure-policy tests |
| Requester owns the final required contribution | Deterministic compilation and completion tests |
| Nested delegation is refused and the per-round limit is two | Pure compilation and API tests |
| Revocation before dispatch prevents execution | API test |
| Cancellation fences a late child result | API test |
| A crash after manifest persistence does not duplicate the child round or dispatch | Injected persistence failure and reaper recovery test |
| Staging is distinct from execution; child completion is distinct from requester-reported completion | `web/tests/directDelegations.test.ts` |
| Accessible target controls filter ownership and Computer, preserve successive saves, and retain settings on error | `web/interaction-tests/directDelegation.test.tsx` |
| All runtimes receive the shared report contract; Claude and Codex prompt regressions pin its content | `packages/relay-core/tests/handoff.test.ts` |

## Commands and results

- `npm run test:py`: **3,599 passed, 10 skipped** at the full integration
  checkpoint. Skips are the repository's environment-dependent tests.
- Latest backend regression target, after refusal/non-delivery corrections:
  `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with coverage coverage run --source=relay.collaboration.delegation,relay.agents.delegation,relay.core.agent_delegation -m pytest backend/tests/api/test_direct_delegation_api.py backend/tests/unit/test_direct_delegation.py backend/tests/unit/test_daemon_registry.py backend/tests/unit/test_client_version_parity.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q`:
  **312 passed**.
- `coverage report -m` through the same uv environment: new backend modules
  **95% statements**, including **100%** for pure compilation and input bounds.
- `npm run test:ts`: production builds passed; **2,933 Node tests passed** and
  **810 React tests passed** at the full integration checkpoint. Later additions
  were verified with the focused prompt and interaction targets.
- `npm run test:react:coverage -w web -- directDelegation.test.tsx --coverage.include=src/components/AgentDelegationSettings.tsx --coverage.include=src/components/DirectDelegationCard.tsx`:
  **12 passed**, **97.72% statements**, **94.91% branches**, **100% functions and lines**.
- `npx tsc -p packages/tsconfig.json` and web TypeScript checking passed.
- `ruff check backend`, `cd backend && uv run mypy`, focused web ESLint,
  shared palette/focus/token tests and `git diff --check` passed.
- `npm audit --registry=https://registry.npmjs.org`: **0 vulnerabilities**.
  The configured npm mirror has no audit endpoint, so verification used the
  official registry without modifying configuration.
- Impeccable detector on the changed components and stylesheet: no findings.

## Browser verification and limits

Playwright CLI exercised the exported app at 1280×900 and 390×844 with
browser-intercepted test API responses: permission selection saved, the receipt
expanded to show attributed evidence and acceptance criteria, and the mobile
profile and thread had no horizontal overflow. Screenshots were inspected.
No operational server data was seeded or changed.

The automated execution tests drive the real conductor, database, registry,
command queue and daemon event ingestion. They do not launch a paid agent CLI.
Live model choice to delegate, physical-device accessibility, and a hosted
deployment were not exercised. Installed Computers need the newly advertised
`direct-delegation` capability to receive the delegation prompt.
