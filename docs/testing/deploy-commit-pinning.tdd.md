# Deploy commit pinning

The user requested fixes for automatic Railway deployments bypassing a selected
release SHA and Cloudflare Worker files coming from the local checkout.

## Regression evidence

| Guarantee | Test | Evidence |
| --- | --- | --- |
| Remove all pages of existing autodeploy triggers before deploying | `bash deploy/tests/release.sh` | RED: the original implementation attempted deployment without removing either trigger. GREEN: both triggers removed before the pinned deployment. |
| Stop if a trigger cannot be removed | `bash deploy/tests/release.sh` | GREEN: a false deletion result stops the release. |
| New services use a repository source without `serviceConnect` | `bash deploy/tests/release.sh` | GREEN: source update and explicit deploy succeed; unexpected connection mutations are rejected by the mock. |
| Publish Worker code and headers from the selected SHA | `bash deploy/tests/workers-source.sh` | RED: the original implementation did not extract runtime files. GREEN: extraction and publication use selected bytes despite newer committed bytes. |
| Upgrade an existing branch-connected service | `bash deploy/tests/run.sh` | The mock creates a legacy autodeploy trigger and verifies its removal and the selected release SHA. |
| Disable every target before the first build | `bash deploy/tests/run.sh` | RED: a backend deployment was attempted while the worker still had a legacy trigger. GREEN is checked by the mock before every deployment and by the manual-release regression. |
| Disable retained Railway UI triggers when Cloudflare hosts the UI | `bash deploy/tests/run.sh` | RED: migration left the retained UI's main-branch trigger active. The migration regression checks that the service remains, has no triggers, and receives no new deployment. |

The deploy tests use local Git fixtures, fake Docker builds, and mock APIs.
They do not measure coverage or exercise live Railway or Cloudflare resources.
Railway input and mutation names were checked against the public schema in
[`railwayapp/cli`](https://github.com/railwayapp/cli/blob/master/src/gql/schema.json).
Final validation: `bash deploy/tests/run.sh` passed all 169 checks, including
the retained Railway UI regression; shell syntax checks and `git diff --check`
also passed. No intermediate checkpoint commits
were created.
