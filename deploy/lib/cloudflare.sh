# Cloudflare v4 REST API. Records and rules are converged in place: rules this
# script owns carry a `relay_` ref, and every rule without one is left as is.

# cf <method> <path> [json-body] — prints the response's `result`.
cf() {
  local method=$1 path=$2 body=${3:-} resp
  if [ -n "$body" ]; then
    resp=$(curl -sS --max-time 60 -X "$method" "$CLOUDFLARE_API_URL$path" \
      -H @<(bearer_header "$CLOUDFLARE_API_TOKEN") -H 'Content-Type: application/json' \
      --data-binary @- <<<"$body") || die "Cloudflare API unreachable at $CLOUDFLARE_API_URL"
  else
    resp=$(curl -sS --max-time 60 -X "$method" "$CLOUDFLARE_API_URL$path" \
      -H @<(bearer_header "$CLOUDFLARE_API_TOKEN")) || die "Cloudflare API unreachable at $CLOUDFLARE_API_URL"
  fi
  jq -e . >/dev/null 2>&1 <<<"$resp" || die "Cloudflare API returned non-JSON for $method $path"
  if ! jq -e '.success == true' >/dev/null <<<"$resp"; then
    die "Cloudflare API $method $path: $(jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$resp")"
  fi
  jq -c '.result' <<<"$resp"
}

cf_zone_id() {
  local id
  id=$(cf GET "/zones?name=$CLOUDFLARE_ZONE" | jq -r '.[0].id // empty')
  [ -n "$id" ] || die "Cloudflare zone $CLOUDFLARE_ZONE not found — add the domain to Cloudflare first, or check the token's zone access"
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
  existing=$(cf GET "/zones/$zone/dns_records?name=$name&per_page=100")

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
  local zone=$1 setting=$2 value=$3 current
  current=$(cf GET "/zones/$zone/settings/$setting" | jq -r '.value')
  if [ "$current" = "$value" ]; then
    info "$setting is already $value"
    return
  fi
  cf PATCH "/zones/$zone/settings/$setting" "$(jq -nc --arg v "$value" '{value: $v}')" >/dev/null
  info "$setting: $current -> $value"
}

# Rules of a phase entrypoint, or [] when the zone has none yet (404).
cf_phase_rules() {
  local zone=$1 phase=$2 resp status
  resp=$(curl -sS --max-time 60 -w '\n%{http_code}' "$CLOUDFLARE_API_URL/zones/$zone/rulesets/phases/$phase/entrypoint" \
    -H @<(bearer_header "$CLOUDFLARE_API_TOKEN")) || die "Cloudflare API unreachable at $CLOUDFLARE_API_URL"
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
  existing=$(cf_phase_rules "$zone" "$phase")
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

# Cache rules (deployment-cloudflare.md § 3), in precedence order.
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
        "(http.host eq \"\($api)\" and http.request.uri.path in {\"/install.sh\" \"/computer/install.sh\"})"; {cache: false}),
      rule("relay_cache_next_static"; "Relay: content-hashed web assets";
        "(http.host eq \"\($web)\" and starts_with(http.request.uri.path, \"/_next/static/\"))";
        {cache: true, edge_ttl: {mode: "override_origin", default: 31536000}}),
      rule("relay_cache_daemon_bundles"; "Relay: digest-named daemon bundles"; api_path("/computer/daemon-");
        {cache: true, edge_ttl: {mode: "respect_origin"}})
    ]'
}
