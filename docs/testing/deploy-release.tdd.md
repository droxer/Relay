# Deployment release regression evidence

Journeys derived from the deployment review: an operator can release without
leaving a split API without a worker after a local build failure, turn email
off through the release config, and update Railway web build origins.

`python3 deploy/tests/release-config.py` executes the real Bash orchestration
functions with external operations stubbed. Before the fix, all three tests
failed. After the fix, all three pass:

| Guarantee | Regression test |
| --- | --- |
| A failed local web build starts no API deployment | `test_build_failure_does_not_start_api` |
| Explicitly disabled mail is removed before worker variables are reconciled | `test_release_removes_explicitly_disabled_mail_before_worker_config` |
| Railway web build variables match the configured origins before deployment | `test_railway_web_release_refreshes_build_variables` |

The regression tests are included in `bash deploy/tests/run.sh`, which also
exercises provisioning, repeat releases, both web hosting modes, migration
failure ordering, and Worker publication against mock APIs. Docker is stubbed;
these tests do not validate a real account deployment. The Bash test suite has
no coverage instrumentation; no numeric coverage claim is made.

The RED checkpoint is `e28fac4a`. Preserve this RED/GREEN evidence when squashing.
