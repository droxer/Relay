"""Release failure and configuration regressions, with external operations stubbed."""
import subprocess
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy.sh"


class ReleaseTests(unittest.TestCase):
    def run_shell(self, script):
        # Load the real orchestration functions without invoking the CLI main.
        source = DEPLOY.read_text().removesuffix('main "$@"\n')
        source = source.replace('DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)',
                                f'DEPLOY_DIR="{DEPLOY.parent}"')
        result = subprocess.run(["bash", "-c", source + "\n" + script],
                                text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_build_failure_does_not_start_api(self):
        self.run_shell('''
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RELEASE_COMMIT=test
BACKEND_SERVICE=api
BACKEND_ID=api-id
require_cmd() { :; }
cf_zone_id() { echo zone; }
railway_deploy_service() { touch "$WORK/deployed"; echo deployment; }
workers_build_export() { exit 1; }
if (release_backend_and_worker); then exit 1; fi
[ ! -e "$WORK/deployed" ]
''')

    def test_release_removes_explicitly_disabled_mail_before_worker_config(self):
        self.run_shell('''
GITHUB_REPO=test/repo
GITHUB_BRANCH=main
BACKEND_SERVICE=api
WORKER_SERVICE=worker
WEB_SERVICE=web
POSTGRES_SERVICE=db
BACKEND_ID=api-id
RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID=
RELAY_MAIL_CLOUDFLARE_API_TOKEN=
RELAY_MAIL_FROM=
require_r2_storage() { :; }
railway_release_commit() { echo sha; }
railway_validate_release() { :; }
resolve_services() { :; }
railway_service_id() { echo "$1"; }
railway_service_repo() { echo "$GITHUB_REPO"; }
railway_disable_autodeploy() { :; }
railway_wait_deployment() { :; }
railway_ensure_service() { :; }
railway_variables() { echo '{"RELAY_MAIL_FROM":"old@example.com"}'; }
backend_variables() { echo '{}'; }
railway_upsert_variables() { :; }
railway_delete_variable() { REMOVED_MAIL=$2; }
configure_worker_service() { [ "${REMOVED_MAIL:-}" = RELAY_MAIL_FROM ] || exit 1; }
workers_enabled() { return 0; }
release_backend_and_worker() { :; }
phase_release
''')

    def test_railway_web_release_refreshes_build_variables(self):
        self.run_shell('''
BACKEND_SERVICE=api
BACKEND_ID=api-id
WEB_SERVICE=web
WEB_ID=web-id
WORKER_SERVICE=worker
WORKER_ID=worker-id
API_ORIGIN=https://new-api.example.com
WEB_ORIGIN=https://new-web.example.com
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
railway_upsert_variables() { printf '%s' "$2" > "$WORK/variables"; }
railway_deploy_service() {
  if [ "$1" = web ]; then
    [ -f "$WORK/variables" ] || exit 1
    jq -e --arg api "$API_ORIGIN" --arg web "$WEB_ORIGIN" \\
      '.NEXT_PUBLIC_RELAY_API_ORIGIN == $api and .NEXT_PUBLIC_RELAY_SITE_URL == $web' \\
      "$WORK/variables" >/dev/null || exit 1
  fi
  echo deployment
}
railway_wait_deployment() { :; }
release_backend_and_web_service
''')


if __name__ == "__main__":
    unittest.main()
