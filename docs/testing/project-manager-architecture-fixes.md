# Project Manager architecture fixes

Verified on 2026-11-06. This is the current evidence for the architecture review
follow-up; [the earlier feature record](project-manager.tdd.md) describes the
initial role/MCP implementation.

## Guarantees

1. Managed native MCP servers use daemon-owned Project/run context and cannot
   fall back to the standalone Computer credential. The daemon proxy exchanges
   its enrollment credential for a command-bound MCP token; every Project call
   uses that token. Non-manager managed processes receive a disabled context.
2. Both PUT manager and PATCH roster commit an explicit conversation handover
   with the role change. Historical participants and runs remain attributable;
   the current Thread owner and saved composer target move to the new manager.
   The backend refuses stale canonical targets. Failed event persistence rolls
   back both changes on SQLite and PostgreSQL.
3. Standalone credentials are checked periodically and renewed near/after expiry.
   Revoked credentials remain blocked until explicit reconnection. Installation
   retries transient failure, reconciles newly ready runtimes and recovers dead
   installer locks. Status is recorded privately and exposed by daemon doctor.
4. The enabled Project role resolves the manager run context independently of
   the canonical Thread. A manager can stage an attributed proposal in another
   Project conversation without creating a special canonical Thread.

## RED checkpoint

Commit `afac861f` captures the failing regression tests before implementation:
three API failures (handover owner remained old, manager capability missing in
another Thread, and healthy-token checking issued another grant), one composer
failure, and missing managed-scope/reconciliation interfaces. The package type
check alone was skipped for this intentional RED checkpoint; normal hooks run
for the implementation commit.

## GREEN evidence

| Check | Result |
| --- | --- |
| Full Python suite | 3,643 passed, 10 skipped. |
| Project/API/role/layering/module/auth/capability regression set | 177 passed. |
| PostgreSQL manager/MCP/reducer/migration/schema set | 45 passed; additional atomic-handover and ordinary-Thread MCP checks also passed. |
| Full built Node suites | 2,951 passed with `--test-concurrency=4`. |
| React interactions | 827 passed; includes reassignment before Agent-directory loading completes. |
| Browser workflows | Four workflows repeated twice: eight passed. Desktop English, mobile English, mobile Chinese dark mode, and reopening/sending after handover with an obsolete saved Agent target. |
| Backend coverage | 88% aggregate over manager role/context, handover, MCP API and token store; MCP API 84%, roles 96%, token store 93%. |
| MCP TypeScript coverage | 98.85% lines and 93.33% functions across server, managed proxy, bootstrap/reconciliation and installer. |
| Production build | Full workspace build and web export passed. |
| Static checks | Ruff, mypy (417 modules), package/web type checks, stylelint passed. ESLint: zero errors, three pre-existing warnings. |
| Dependency audit | Zero vulnerabilities; no dependency changes in this follow-up. |

The first unconstrained Node run hit the existing Codex adapter's 400 ms abort
fixture before its child recorded SIGTERM. Its 14-scenario suite passed on its
own; the final full run with bounded concurrency passed all 2,951 tests. No
adapter implementation or assertion was weakened.

Actual subprocess tests cover managed stdio calls with a nonexistent standalone
token file, cross-Project refusal before proxy issuance, one command-bound token
per run proxy, correct HTTP bearer-token use, environment forwarding for all five
runtime launchers, token renewal/revocation, configuration ownership and installer
lock recovery. Browser APIs and external runtime hosts are fixtures. Authenticated
third-party model-provider sessions were not launched.

The final atomic rollback scenario was added after collection of the full Python
suite, and separately passed on SQLite/PostgreSQL. Final manager/MCP API checks
and the ordinary-Thread attribution scenario were rerun after that addition.

## Rollout

Install the rebuilt Computer client advertising `project-manager-mcp`; older
clients are refused for these manager runs. No new schema migration is required
beyond 0115 (MCP tokens, sequenced after Connections revision 0114). Restart open standalone Agent Runtimes to load the updated MCP
configuration. Managed launches verify forwarding configuration before execution.
See [the current design](../project-manager-design.md) for credential scope,
renewal/revocation, runtime configuration and handover semantics.

## Integration with Connections on main

Merged main at `b9c4d61f`, preserving both `service-connections` and
`project-manager-mcp` capabilities and their runtime paths. Main already owns
migration 0114 for Connections, so the unmerged MCP token migration is now 0115,
with 0114 as its parent. The merged application passes the full production build,
51 backend checks (manager/MCP/Connections APIs, layering, module size and client
capability parity), 16 focused Node checks, 16 React interactions and 17 PostgreSQL
migration/schema checks. Dependency audit reports zero vulnerabilities.
