#!/bin/sh
# Served with a release URL, digest and backend origin injected by the Relay backend.
# Keep all work inside functions: a truncated download must not run half a script.
# Published as `curl … | sudo bash`. POSIX sh throughout, so commands copied
# before that (`| sh`) keep working; only the sudo hand-off needs bash.
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    else shasum -a 256 "$1" | awk '{print $1}'; fi
}
download() { curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 300 "$1" -o "$2"; }

# Relay is per-user: the client, its service and the agent logins all live in
# the invoking account. Root therefore installs nothing itself and only hands
# the install to that account's login shell, which restores the PATH sudo reset.
install_as_invoking_user() {
    relay_user=${SUDO_USER:-}
    [ -n "$relay_user" ] && [ "$(id -u "$relay_user")" != 0 ] || fail 'Relay installs for your own account. Run this command with sudo from your normal user, not from a root shell.'
    [ -n "${BASH_VERSION:-}" ] || fail 'Pipe the installer to bash: curl … | sudo bash'
    # The script itself was consumed from stdin, so replay its functions. Arguments
    # travel in that stream, quoted, never through the login shell's command line.
    {
        printf 'set -eu\n'
        declare -f fail sha256 download install_relay
        printf 'RELAY_SUDO_PATH=%q\ninstall_relay' "$PATH"
        [ "$#" -eq 0 ] || printf ' %q' "$@"
        printf '\n'
    } | sudo -i -u "$relay_user" bash -s
}

install_relay() {
    [ "$(id -u)" != 0 ] || fail 'Relay cannot be installed for root. Run this command with sudo from your normal user.'
    # A login shell skips interactive rc files; keep what the sudo caller could reach.
    [ -z "${RELAY_SUDO_PATH:-}" ] || PATH="$PATH:$RELAY_SUDO_PATH"
    # sudo drops the variable systemctl --user needs to find the session manager.
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
        XDG_RUNTIME_DIR="/run/user/$(id -u)"
        export XDG_RUNTIME_DIR
    fi
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Relay supports macOS and Linux.' ;; esac
    case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Unsupported CPU architecture.' ;; esac
    for utility in curl tar awk; do command -v "$utility" >/dev/null 2>&1 || fail "Required command missing: $utility"; done
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail 'SHA-256 verification requires shasum or sha256sum.'
    backend_given=false
    for arg in "$@"; do [ "$arg" != '--backend-url' ] || backend_given=true; done
    [ "$backend_given" = true ] || set -- --backend-url @@BACKEND_URL@@ "$@"
    umask 077
    relay_root="$HOME/.local/share/relay"
    mkdir -p "$relay_root/releases"
    relay_tmp=$(mktemp -d "$relay_root/.install.XXXXXX")
    trap 'rm -rf "$relay_tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    printf '%s\n' 'Downloading Relay…'
    download @@BUNDLE_URL@@ "$relay_tmp/daemon.tar.gz"
    [ "$(sha256 "$relay_tmp/daemon.tar.gz")" = '@@BUNDLE_SHA256@@' ] || fail 'Relay download checksum mismatch.'
    mkdir "$relay_tmp/client"
    tar -xzf "$relay_tmp/daemon.tar.gz" -C "$relay_tmp/client"
    relay_node=$(command -v node || true)
    if [ -z "$relay_node" ] || ! "$relay_node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || a===22 && b>=19 ? 0 : 1)'; then
        printf '%s\n' 'Installing a private Node.js 24 runtime…'
        node_origin=https://nodejs.org/dist/latest-v24.x
        download "$node_origin/SHASUMS256.txt" "$relay_tmp/SHASUMS256.txt"
        node_file=$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ /node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$relay_tmp/SHASUMS256.txt")
        case "$node_file" in node-v24.*-"$platform"-"$arch".tar.gz) ;; *) fail 'Cannot find a supported Node.js runtime.' ;; esac
        node_sha=$(awk -v file="$node_file" '$2==file {print $1}' "$relay_tmp/SHASUMS256.txt")
        download "$node_origin/$node_file" "$relay_tmp/node.tar.gz"
        [ "$(sha256 "$relay_tmp/node.tar.gz")" = "$node_sha" ] || fail 'Node.js download checksum mismatch.'
        mkdir "$relay_tmp/node"
        tar -xzf "$relay_tmp/node.tar.gz" -C "$relay_tmp/node" --strip-components=1
        mkdir -p "$relay_root/runtimes"
        runtime="$relay_root/runtimes/${node_file%.tar.gz}"
        if [ ! -d "$runtime" ]; then mv "$relay_tmp/node" "$runtime"; fi
        relay_node="$runtime/bin/node"
    fi
    release="$relay_root/releases/@@BUNDLE_SHA256@@"
    if [ ! -d "$release" ]; then mv "$relay_tmp/client" "$release"; fi
    legacy_setup=false
    for arg in "$@"; do [ "$arg" != '--sandbox-id' ] || legacy_setup=true; done
    # Prompt on the controlling terminal, never on the piped script's stdin.
    # The token travels only via the child environment, never argv or history.
    if [ "$legacy_setup" = true ] && [ -z "${RELAY_DAEMON_NODE_TOKEN:-}" ]; then
        printf 'Relay node token: ' >/dev/tty
        tty_state=$(stty -g </dev/tty)
        trap 'stty "$tty_state" </dev/tty; exit 1' HUP INT TERM
        stty -echo </dev/tty
        IFS= read -r RELAY_DAEMON_NODE_TOKEN </dev/tty || { stty "$tty_state" </dev/tty; fail 'Could not read node token.'; }
        stty "$tty_state" </dev/tty
        trap 'exit 1' HUP INT TERM
        printf '\n' >/dev/tty
    fi
    [ "$legacy_setup" != true ] || [ -n "${RELAY_DAEMON_NODE_TOKEN:-}" ] || fail 'Node token must not be empty.'
    # The workspace prompt lives here too: read(1) retries the EINTR that sudo's
    # terminal relay causes, while Node's fs read of /dev/tty crashes on it.
    workspace_given=false
    for arg in "$@"; do [ "$arg" != '--workspace' ] || workspace_given=true; done
    if [ "$legacy_setup" != true ] && [ "$workspace_given" != true ] && (: </dev/tty) 2>/dev/null; then
        printf 'Local workspace directory (absolute path): ' >/dev/tty
        read -r relay_workspace </dev/tty || fail 'Could not read the workspace directory.'
        case "$relay_workspace" in
            '~') relay_workspace=$HOME ;;
            '~/'*) relay_workspace="$HOME/${relay_workspace#'~/'}" ;;
        esac
        [ -n "$relay_workspace" ] || fail 'Workspace directory must not be empty.'
        set -- "$@" --workspace "$relay_workspace"
    fi
    export RELAY_DAEMON_NODE_TOKEN
    "$relay_node" "$release/node_modules/relay-daemon/dist/install.js" "$@"
}

main() {
    if [ "$(id -u)" = 0 ]; then install_as_invoking_user "$@"; else install_relay "$@"; fi
}
main "$@"
