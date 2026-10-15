# Shared helpers for deploy.sh: logging, configuration, and secrets.
# Sourced, never executed. Written for bash 3.2 (macOS) as well as bash 5.

# Color only a terminal, and never under NO_COLOR (https://no-color.org), so
# piped logs and the test harness's pattern matches stay plain text.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW=''
fi

log() { printf '%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET" >&2; }
info() { printf '    %s\n' "$*" >&2; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
  done
}

# Load deploy/.env (or the file named by DEPLOY_CONFIG) and apply defaults.
load_config() {
  local file=$1
  [ -f "$file" ] || die "config not found: $file — copy deploy/config.example.env to it and fill it in"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a

  : "${RAILWAY_API_URL:=https://backboard.railway.com/graphql/v2}"
  : "${CLOUDFLARE_API_URL:=https://api.cloudflare.com/client/v4}"
  : "${RAILWAY_PROJECT_NAME:=relay}"
  : "${RAILWAY_ENVIRONMENT:=production}"
  : "${GITHUB_REPO:=droxer/Relay}"
  : "${GITHUB_BRANCH:=main}"
  : "${BACKEND_SERVICE:=relay-backend}"
  : "${WEB_SERVICE:=relay-web}"
  : "${WEB_HOSTING:=workers}"
  : "${WORKERS_SCRIPT:=relay-web}"
  : "${POSTGRES_SERVICE:=Postgres}"
  : "${CLOUDFLARE_ZONE:=get-relay.cc}"
  : "${WEB_DOMAIN:=get-relay.cc}"
  : "${API_DOMAIN:=api.get-relay.cc}"
  : "${COOKIE_DOMAIN:=.${CLOUDFLARE_ZONE}}"
  : "${DEPLOY_TIMEOUT_SECONDS:=1200}"
  : "${DEPLOY_POLL_SECONDS:=10}"
  WEB_ORIGIN="https://${WEB_DOMAIN}"
  API_ORIGIN="https://${API_DOMAIN}"
}

validate_config() {
  [ -n "${RAILWAY_API_TOKEN:-}" ] || die "RAILWAY_API_TOKEN is required (an account or workspace token, not a project token)"
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is required"
  validate_hostname "$CLOUDFLARE_ZONE" CLOUDFLARE_ZONE
  validate_hostname "$WEB_DOMAIN" WEB_DOMAIN
  validate_hostname "$API_DOMAIN" API_DOMAIN
  in_zone "$WEB_DOMAIN" || die "WEB_DOMAIN ($WEB_DOMAIN) is not inside CLOUDFLARE_ZONE ($CLOUDFLARE_ZONE)"
  in_zone "$API_DOMAIN" || die "API_DOMAIN ($API_DOMAIN) is not inside CLOUDFLARE_ZONE ($CLOUDFLARE_ZONE)"
  [ "$WEB_DOMAIN" != "$API_DOMAIN" ] || die "WEB_DOMAIN and API_DOMAIN must differ"
  case $WEB_HOSTING in
    workers | railway) ;;
    *) die "WEB_HOSTING must be workers or railway, not $WEB_HOSTING" ;;
  esac
  printf '%s' "$WORKERS_SCRIPT" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' \
    || die "WORKERS_SCRIPT must be a lowercase Worker name: $WORKERS_SCRIPT"
  case $COOKIE_DOMAIN in
    ".$CLOUDFLARE_ZONE") ;;
    *) die "COOKIE_DOMAIN must be .$CLOUDFLARE_ZONE so the web and API hosts share the session cookie" ;;
  esac
  case $GITHUB_REPO in
    */*) ;;
    *) die "GITHUB_REPO must look like owner/name" ;;
  esac
  if r2_enabled; then
    local key
    for key in RELAY_R2_ACCOUNT_ID RELAY_R2_ACCESS_KEY_ID RELAY_R2_SECRET_ACCESS_KEY RELAY_R2_BUCKET; do
      eval "[ -n \"\${$key:-}\" ]" || die "$key is required when RELAY_R2_BUCKET or any RELAY_R2_* key is set"
    done
  fi
}

validate_hostname() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' \
    || die "$2 is not a lowercase hostname: $1"
}

in_zone() {
  case $1 in
    "$CLOUDFLARE_ZONE" | *".$CLOUDFLARE_ZONE") return 0 ;;
    *) return 1 ;;
  esac
}

# R2 is on when any of its keys is configured; validate_config demands all four.
r2_enabled() {
  [ -n "${RELAY_R2_BUCKET:-}${RELAY_R2_ACCOUNT_ID:-}${RELAY_R2_ACCESS_KEY_ID:-}${RELAY_R2_SECRET_ACCESS_KEY:-}" ]
}

random_secret() {
  openssl rand -hex 32
}

# Print an auth header for curl's `-H @file`, so tokens never appear in argv.
bearer_header() {
  printf 'Authorization: Bearer %s\n' "$1"
}
