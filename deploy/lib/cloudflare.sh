# Cloudflare v4 REST API. Records and rules are converged in place: rules this
# script owns carry a `relay_` ref, and every rule without one is left as is.

# cf_curl <method> <path> [json-body] [curl-args...] — prints the raw response.
# A GET is safe to replay after an interrupted connection. A write may already
# have taken effect, so leave its recovery to the next converging run. The
# token header is rebuilt per attempt: a process substitution reads only once.
cf_curl() {
  local method=$1 path=$2 body=${3:-} resp attempt=1 attempts=1 status
  shift 2
  [ $# -eq 0 ] || shift
  [ "$method" != GET ] || attempts=3
  while :; do
    if [ -n "$body" ]; then
      resp=$(curl -sS --connect-timeout 10 --max-time 60 -X "$method" "$CLOUDFLARE_API_URL$path" "$@" \
        -H @<(bearer_header "$CLOUDFLARE_API_TOKEN") -H 'Content-Type: application/json' \
        --data-binary @- <<<"$body") && break
    else
      resp=$(curl -sS --connect-timeout 10 --max-time 60 -X "$method" "$CLOUDFLARE_API_URL$path" "$@" \
        -H @<(bearer_header "$CLOUDFLARE_API_TOKEN")) && break
    fi
    status=$?
    case $status in
      5 | 6 | 7 | 18 | 28 | 35 | 52 | 55 | 56) ;;
      *) die "Cloudflare API unreachable at $CLOUDFLARE_API_URL (curl $status)" ;;
    esac
    [ "$attempt" -lt "$attempts" ] || die "Cloudflare API unreachable at $CLOUDFLARE_API_URL after $attempt attempt(s) (curl $status); re-run the interrupted phase"
    warn "Cloudflare connection failed (curl $status); retrying read request ($((attempt + 1))/$attempts)"
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
  printf '%s' "$resp"
}

# cf <method> <path> [json-body] — prints the response's `result`. Callers
# capture it with $(...), which does not inherit errexit: check `|| return 1`.
cf() {
  local method=$1 path=$2 body=${3:-} resp
  resp=$(cf_curl "$method" "$path" "$body") || return 1
  jq -e . >/dev/null 2>&1 <<<"$resp" || die "Cloudflare API returned non-JSON for $method $path"
  if ! jq -e '.success == true' >/dev/null <<<"$resp"; then
    die "Cloudflare API $method $path: $(jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$resp")"
  fi
  jq -c '.result' <<<"$resp"
}

cf_zone_id() {
  local zones id
  zones=$(cf GET "/zones?name=$CLOUDFLARE_ZONE") || return 1
  id=$(jq -r '.[0].id // empty' <<<"$zones")
  [ -n "$id" ] || die "Cloudflare zone $CLOUDFLARE_ZONE not found — add the domain to Cloudflare first, or check the token's zone access"
  printf '%s' "$id"
}

# The account that owns the zone, where the web UI's Worker lives.
cf_zone_account_id() {
  local zones id
  zones=$(cf GET "/zones?name=$CLOUDFLARE_ZONE") || return 1
  id=$(jq -r '.[0].account.id // empty' <<<"$zones")
  [ -n "$id" ] || die "cannot read the account of zone $CLOUDFLARE_ZONE; check the token's zone access"
  printf '%s' "$id"
}

# Lowercase, without a trailing dot or the quotes Cloudflare adds to TXT values.
cf_normalize() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -e 's/\.$//' -e 's/^"//' -e 's/"$//'
}

# cf_ensure_record <zone-id> <record-json {type,name,content,proxied}>
cf_ensure_record() {
  local zone=$1 record=$2 type name content proxied existing same conflicts id
  type=$(jq -r .type <<<"$record")
  name=$(jq -r .name <<<"$record")
  content=$(jq -r .content <<<"$record")
  proxied=$(jq -r .proxied <<<"$record")
  existing=$(cf GET "/zones/$zone/dns_records?name=$name&per_page=100") || return 1

  if [ "$type" = TXT ]; then
    same=$(jq -r --arg want "$(cf_normalize "$content")" \
      '[.[] | select(.type == "TXT") | .content | ascii_downcase | ltrimstr("\"") | rtrimstr("\"") | select(. == $want)] | length' <<<"$existing")
    if [ "$same" -gt 0 ]; then
      info "TXT $name is up to date"
    else
      cf POST "/zones/$zone/dns_records" "$(jq -nc --arg n "$name" --arg c "$content" '{type: "TXT", name: $n, content: $c, ttl: 1}')" >/dev/null
      info "created TXT $name"
    fi
    return
  fi

  # A routing name holds one A/AAAA/CNAME set. Never delete someone else's.
  conflicts=$(jq -r --arg t "$type" '[.[] | select((.type == "A" or .type == "AAAA" or .type == "CNAME") and .type != $t) | "\(.type) \(.content)"] | join(", ")' <<<"$existing")
  [ -z "$conflicts" ] || die "$name already has $conflicts in Cloudflare; delete it, then re-run (Railway needs a $type to $content)"

  conflicts=$(jq -r --arg t "$type" --arg c "$(cf_normalize "$content")" \
    '[.[] | select(.type == $t) | select((.content | ascii_downcase | rtrimstr(".")) != $c) | .content] | join(", ")' <<<"$existing")
  [ -z "$conflicts" ] || die "$name already points to $conflicts; refusing to overwrite it with $content"

  id=$(jq -r --arg t "$type" '[.[] | select(.type == $t)][0].id // empty' <<<"$existing")
  if [ -z "$id" ]; then
    cf POST "/zones/$zone/dns_records" \
      "$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" '{type: $t, name: $n, content: $c, proxied: $p, ttl: 1}')" >/dev/null
    info "created $type $name -> $content (proxied: $proxied)"
  elif jq -e --arg id "$id" --arg c "$(cf_normalize "$content")" --argjson p "$proxied" \
    '.[] | select(.id == $id) | (.content | ascii_downcase | rtrimstr(".")) == $c and .proxied == $p' >/dev/null <<<"$existing"; then
    info "$type $name is up to date"
  else
    cf PUT "/zones/$zone/dns_records/$id" \
      "$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" '{type: $t, name: $n, content: $c, proxied: $p, ttl: 1}')" >/dev/null
    info "updated $type $name -> $content (proxied: $proxied)"
  fi
}

cf_zone_setting() {
  cf_zone_value "$2" "/zones/$1/settings/$2" "$3"
}

# cf_zone_value <label> <path> <value>, for {value} settings that live outside
# /settings, such as Smart Tiered Cache.
cf_zone_value() {
  local label=$1 path=$2 value=$3 current
  current=$(cf GET "$path") || return 1
  current=$(jq -r '.value' <<<"$current")
  if [ "$current" = "$value" ]; then
    info "$label is already $value"
    return
  fi
  cf PATCH "$path" "$(jq -nc --arg v "$value" '{value: $v}')" >/dev/null
  info "$label: $current -> $value"
}

# Free speed-ups that are safe for the API's SSE streams: HTTP/3 and 0-RTT
# shorten connection setup, Early Hints preloads assets while HTML is still
# in flight, and Smart Tiered Cache sends edge misses to a regional Cloudflare
# cache before the origin (deployment-cloudflare.md § 3).
cf_performance_settings() {
  local zone=$1
  cf_zone_setting "$zone" http3 on
  cf_zone_setting "$zone" 0rtt on
  cf_zone_setting "$zone" early_hints on
  cf_zone_value tiered_cache_smart_topology "/zones/$zone/cache/tiered_cache_smart_topology_enable" on
}

# Rules of a phase entrypoint, or [] when the zone has none yet (404).
cf_phase_rules() {
  local zone=$1 phase=$2 resp status
  resp=$(cf_curl GET "/zones/$zone/rulesets/phases/$phase/entrypoint" '' -w '\n%{http_code}') || return 1
  status=$(tail -n 1 <<<"$resp")
  case $status in
    200) sed '$d' <<<"$resp" | jq -c '.result.rules // []' ;;
    404) echo '[]' ;;
    *) die "Cloudflare API GET $phase entrypoint: HTTP $status $(sed '$d' <<<"$resp" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null)" ;;
  esac
}

# cf_upsert_phase_rules <zone-id> <phase> <rules-json>. Replaces the rules
# whose ref this script owns and keeps every other rule in its place.
cf_upsert_phase_rules() {
  local zone=$1 phase=$2 desired=$3 existing merged
  existing=$(cf_phase_rules "$zone" "$phase") || return 1
  if jq -e --argjson want "$desired" '
      def shape: {ref, description, expression, action, action_parameters, enabled};
      ([.[] | select(.ref as $r | $want | map(.ref) | index($r)) | shape] | sort_by(.ref))
        == ($want | map(shape) | sort_by(.ref))' >/dev/null <<<"$existing"; then
    info "$phase rules are up to date"
    return
  fi
  merged=$(jq -c --argjson want "$desired" '
      [.[] | select(.ref as $r | ($want | map(.ref) | index($r)) | not) | del(.version, .last_updated, .categories)]
      + $want | {rules: .}' <<<"$existing")
  cf PUT "/zones/$zone/rulesets/phases/$phase/entrypoint" "$merged" >/dev/null
  info "$phase rules updated ($(jq length <<<"$desired") owned by Relay)"
}

# The origin lock (deployment-cloudflare.md § 2), scoped to the API host so
# the secret never travels to any other origin.
cf_edge_secret_rule() {
  jq -nc --arg host "$API_DOMAIN" --arg secret "$1" '[{
    ref: "relay_edge_secret",
    description: "Relay: origin-lock header for the API",
    expression: "(http.host eq \"\($host)\")",
    action: "rewrite",
    action_parameters: {headers: {"X-Relay-Edge": {operation: "set", value: $secret}}},
    enabled: true
  }]'
}

# Cache rules (deployment-cloudflare.md § 3), in precedence order. Under
# WEB_HOSTING=workers the Worker answers the web host before the zone cache, so
# relay_cache_next_static only acts when Railway serves the web UI.
cf_cache_rules() {
  jq -nc --arg api "$API_DOMAIN" --arg web "$WEB_DOMAIN" '
    def rule(ref; description; expression; params):
      {ref: ref, description: description, expression: expression,
       action: "set_cache_settings", action_parameters: params, enabled: true};
    def api_path(prefix): "(http.host eq \"\($api)\" and starts_with(http.request.uri.path, \"\(prefix)\"))";
    [
      rule("relay_cache_api"; "Relay: never cache the API or SSE"; api_path("/api/"); {cache: false}),
      rule("relay_cache_profile_images"; "Relay: per-user profile images"; api_path("/profile-images/"); {cache: false}),
      rule("relay_cache_install_script"; "Relay: install script pins the current bundle";
        "(http.host eq \"\($api)\" and http.request.uri.path in {\"/install.sh\" \"/computer/install.sh\" \"/install.ps1\" \"/computer/install.ps1\"})"; {cache: false}),
      rule("relay_cache_next_static"; "Relay: content-hashed web assets";
        "(http.host eq \"\($web)\" and starts_with(http.request.uri.path, \"/_next/static/\"))";
        # A rollover can send a new chunk to the old instance; never keep that 404.
        {cache: true, edge_ttl: {mode: "override_origin", default: 31536000,
          status_code_ttl: [{status_code_range: {from: 400, to: 599}, value: -1}]}}),
      rule("relay_cache_daemon_bundles"; "Relay: digest-named daemon bundles"; api_path("/computer/daemon-");
        {cache: true, edge_ttl: {mode: "respect_origin"}})
    ]'
}

# cf_ensure_worker_host <zone-id> <domain>. A Worker route only sees proxied
# traffic, so the web host needs a proxied record. An existing one (such as
# the old Railway CNAME) is kept: the route answers in front of it, which
# makes the switch zero-downtime and deleting the route a rollback.
cf_ensure_worker_host() {
  local zone=$1 name=$2 existing routing unproxied
  existing=$(cf GET "/zones/$zone/dns_records?name=$name&per_page=100") || return 1
  routing=$(jq '[.[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME")]' <<<"$existing")
  if [ "$(jq length <<<"$routing")" -eq 0 ]; then
    # 100:: is the discard prefix Cloudflare documents for Worker-only hosts.
    cf POST "/zones/$zone/dns_records" \
      "$(jq -nc --arg n "$name" '{type: "AAAA", name: $n, content: "100::", proxied: true, ttl: 1}')" >/dev/null
    info "created AAAA $name -> 100:: (proxied, served by the Worker)"
    return
  fi
  unproxied=$(jq -r '[.[] | select(.proxied | not) | "\(.type) \(.content)"] | join(", ")' <<<"$routing")
  [ -z "$unproxied" ] || die "$name has DNS-only $unproxied; proxy it in Cloudflare so the Worker route can serve it"
  info "$name keeps its proxied record; the Worker route answers in front of it"
}

# cf_ensure_worker_route <zone-id> <pattern> <script>. Never takes over a
# route that serves another Worker.
cf_ensure_worker_route() {
  local zone=$1 pattern=$2 script=$3 route current body
  route=$(cf GET "/zones/$zone/workers/routes") || return 1
  route=$(jq -c --arg p "$pattern" '[.[] | select(.pattern == $p)][0] // empty' <<<"$route")
  current=$(jq -r '.script // empty' <<<"${route:-null}")
  if [ -n "$route" ] && [ "$current" = "$script" ]; then
    info "route $pattern -> $script is up to date"
    return
  fi
  [ -z "$current" ] || die "route $pattern already serves Worker $current; delete that route, then re-run"
  body=$(jq -nc --arg p "$pattern" --arg s "$script" '{pattern: $p, script: $s}')
  if [ -n "$route" ]; then
    # A route with no Worker disables Workers on the pattern; point it at ours.
    cf PUT "/zones/$zone/workers/routes/$(jq -r .id <<<"$route")" "$body" >/dev/null
    info "updated route $pattern -> $script"
  else
    cf POST "/zones/$zone/workers/routes" "$body" >/dev/null
    info "created route $pattern -> $script"
  fi
}
