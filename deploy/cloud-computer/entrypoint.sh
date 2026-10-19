#!/bin/sh
# Boots one Relay cloud computer. Runs as root only long enough to prepare the
# volume, then hands the daemon to the unprivileged `agent` user — agent CLIs
# refuse to skip permission prompts as root, and nothing here needs root.
set -eu

data=/data
home="${HOME:-$data/home}"
workspace="${RELAY_WORKSPACE:-$data/workspace}"

mkdir -p "$home" "$workspace"
# First boot: seed the agent CLI settings the image ships into the volume home.
if [ ! -e "$home/.relay-seeded" ]; then
    cp -a /home/agent/. "$home/"
    touch "$home/.relay-seeded"
fi
# Walking a large workspace on every boot would delay the daemon, so only a
# volume not already owned by `agent` (first boot, or a restored snapshot) is fixed.
[ "$(stat -c %u "$data")" = "$(id -u agent)" ] && [ "$(stat -c %u "$home")" = "$(id -u agent)" ] \
    || chown -R agent:agent "$data"

export HOME="$home" RELAY_WORKSPACE="$workspace"
exec setpriv --reuid=agent --regid=agent --init-groups \
    node /opt/relay/node_modules/relay-daemon/dist/cli.js "$@"
