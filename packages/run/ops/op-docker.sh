#!/usr/bin/env bash
#
# op-docker — the B1 privilege boundary for openpouch-run's dynamic lane.
#
# run-d (unprivileged user `oprun`) is NOT in the docker group and has no access
# to the Docker socket (which is root-equivalent). Instead it invokes THIS
# script through a tightly-scoped sudoers rule:
#
#     oprun ALL=(root) NOPASSWD: /usr/local/sbin/op-docker
#
# The script exposes only fixed VERBS and constructs the hardened `docker`
# command ITSELF. A compromised run-d therefore cannot inject `-v /:/host`,
# `--privileged`, `--user 0`, `--network host`, mount the docker socket, or
# otherwise escape to host root: it can only build/run/stop sandboxed,
# egress-filtered containers named `op-app-<slug>` / `op-build-<slug>`, bind-
# mounting only the server-assigned site directory it already owns.
#
# Hardening values live HERE (and optionally in $OP_DOCKER_CONF), never in
# run-d's environment — sudo strips run-d's env, so run-d cannot influence them.
#
# Design: claude-code/2026-06-13-b1-dynamic-privilege-model-proposal.md (Option B).
set -euo pipefail

# ── Config (defaults match packages/run/src/server.ts; override via the conf
#    file or env so the box can tune them without editing this script). ────────
OP_DOCKER_CONF="${OP_DOCKER_CONF:-/etc/openpouch-run/op-docker.conf}"
# shellcheck disable=SC1090
[ -r "$OP_DOCKER_CONF" ] && . "$OP_DOCKER_CONF"

DOCKER_BIN="${OP_DOCKER_BIN:-docker}"
IMAGE="${OP_IMAGE:-node:22-alpine}"
NETWORK="${OP_NETWORK:-op-egress}"
SITES_DIR="${OP_SITES_DIR:-/var/openpouch/sites}"
CONTAINER_PORT="${OP_CONTAINER_PORT:-8080}"
PORT_MIN="${OP_PORT_MIN:-20000}"
PORT_MAX="${OP_PORT_MAX:-20999}"
MEM="${OP_MEM:-256m}"
CPUS="${OP_CPUS:-0.5}"
BUILD_MEM="${OP_BUILD_MEM:-512m}"
BUILD_CPUS="${OP_BUILD_CPUS:-1}"
PIDS="${OP_PIDS:-128}"
BUILD_TIMEOUT="${OP_BUILD_TIMEOUT:-120}"
# uid:gid the container runs as = run-d's own user, so it can write the bind
# mount. Resolved from `oprun` by default; omitted if unresolved (e.g. tests).
RUN_USER="${OP_RUN_USER:-$(id -u oprun 2>/dev/null || true):$(id -g oprun 2>/dev/null || true)}"
# Optional build-timeout enforcement (coreutils; absent on stock macOS — fine).
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

die() { echo "op-docker: $*" >&2; exit 2; }

valid_slug()  { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "invalid slug: $1"; }
valid_port()  { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge "$PORT_MIN" ] && [ "$1" -le "$PORT_MAX" ] || die "invalid hostPort: $1"; }
valid_tail()  { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 10000 ] || die "invalid tail: $1"; }

# Derive the bind-mount source from the (already validated) slug — run-d never
# supplies a path. Reject if it is missing or a symlink escaping SITES_DIR.
# Both sides are canonicalized so the prefix check is symlink-safe.
site_dir_for() {
  local slug="$1" dir real base
  dir="$SITES_DIR/$slug"
  [ -d "$dir" ] || die "site dir not found: $dir"
  real="$(realpath "$dir")" || die "cannot resolve site dir"
  base="$(realpath "$SITES_DIR")" || die "cannot resolve sites dir"
  case "$real/" in "$base"/*) : ;; *) die "site dir escapes $base" ;; esac
  printf '%s' "$real"
}

# Fixed hardening profile — NOT overridable by the caller. $1 = "build"|"run".
hardening() {
  HARD=(--network "$NETWORK" --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp)
  [[ "$RUN_USER" =~ ^[0-9]+:[0-9]+$ ]] && HARD+=(--user "$RUN_USER")
  HARD+=(--pids-limit "$PIDS")
  if [ "$1" = "build" ]; then HARD+=(--memory "$BUILD_MEM" --cpus "$BUILD_CPUS")
  else HARD+=(--memory "$MEM" --cpus "$CPUS"); fi
}

verb="${1:-}"; shift || true
case "$verb" in
  build)   # build <slug> <installCmd>
    [ "$#" -eq 2 ] || die "usage: build <slug> <installCmd>"
    valid_slug "$1"; slug="$1"; install="$2"; site="$(site_dir_for "$slug")"
    "$DOCKER_BIN" rm -f "op-build-$slug" >/dev/null 2>&1 || true
    hardening build
    BUILD_CMD=("$DOCKER_BIN" run --rm --name "op-build-$slug"
      "${HARD[@]}" -v "$site:/app" -w /app
      -e HOME=/app -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false -e CI=1
      "$IMAGE" sh -c "$install")
    # Enforce a build timeout when coreutils is available (always on the box).
    [ -n "$TIMEOUT_BIN" ] && BUILD_CMD=("$TIMEOUT_BIN" "${BUILD_TIMEOUT}s" "${BUILD_CMD[@]}")
    exec "${BUILD_CMD[@]}"
    ;;
  buildapp)  # buildapp <slug> <buildCmd> — run the app's build script (e.g. npm run build)
    # Same hardened throwaway build container as `build`; the built output (e.g.
    # dist/) lands in the bind-mounted site dir (build-on-deploy, PRD L9). The
    # command runs via `sh -c` inside the sandbox, so its content cannot escape.
    [ "$#" -eq 2 ] || die "usage: buildapp <slug> <buildCmd>"
    valid_slug "$1"; slug="$1"; build="$2"; site="$(site_dir_for "$slug")"
    "$DOCKER_BIN" rm -f "op-build-$slug" >/dev/null 2>&1 || true
    hardening build
    BUILD_CMD=("$DOCKER_BIN" run --rm --name "op-build-$slug"
      "${HARD[@]}" -v "$site:/app" -w /app
      -e HOME=/app -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false -e CI=1
      "$IMAGE" sh -c "$build")
    [ -n "$TIMEOUT_BIN" ] && BUILD_CMD=("$TIMEOUT_BIN" "${BUILD_TIMEOUT}s" "${BUILD_CMD[@]}")
    exec "${BUILD_CMD[@]}"
    ;;
  create)  # create <slug> <hostPort> <startCmd> [envB64]   envB64 = "KEY base64(value)" lines
    { [ "$#" -eq 3 ] || [ "$#" -eq 4 ]; } || die "usage: create <slug> <hostPort> <startCmd> [env]"
    valid_slug "$1"; valid_port "$2"; slug="$1"; port="$2"; start="$3"; site="$(site_dir_for "$slug")"
    # Optional app env vars/secrets (4th arg): one "KEY base64(value)" per line.
    # Keys are validated; PORT/HOME are reserved; values stay opaque (base64) and
    # are passed to docker as separate argv elements (no shell interpolation, no
    # injection). A malformed entry dies WITHOUT echoing the value (D7).
    ENV_ARGS=()
    if [ "$#" -eq 4 ] && [ -n "$4" ]; then
      # while-read + here-string (bash 3.2-compatible, unlike mapfile); the loop
      # runs in this shell (not a subshell), so ENV_ARGS persists.
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        key="${line%% *}"; valb64="${line#* }"
        printf '%s' "$key" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$' || die "bad env var name"
        if [ "$key" = PORT ] || [ "$key" = HOME ]; then continue; fi
        val="$(printf '%s' "$valb64" | base64 --decode 2>/dev/null)" || die "bad env value encoding"
        ENV_ARGS+=(-e "$key=$val")
      done <<< "$4"
    fi
    "$DOCKER_BIN" rm -f "op-app-$slug" >/dev/null 2>&1 || true
    hardening run
    exec "$DOCKER_BIN" create --name "op-app-$slug" \
      "${HARD[@]}" -v "$site:/app" -w /app \
      -e HOME=/app -e "PORT=$CONTAINER_PORT" -e NODE_ENV=production \
      ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      -p "127.0.0.1:$port:$CONTAINER_PORT" --restart no \
      "$IMAGE" sh -c "$start"
    ;;
  start)   [ "$#" -eq 1 ] || die "usage: start <slug>"; valid_slug "$1"; exec "$DOCKER_BIN" start "op-app-$1" ;;
  stop)    [ "$#" -eq 1 ] || die "usage: stop <slug>";  valid_slug "$1"; exec "$DOCKER_BIN" stop --time 5 "op-app-$1" ;;
  rm)      [ "$#" -eq 1 ] || die "usage: rm <slug>";    valid_slug "$1"; exec "$DOCKER_BIN" rm -f "op-app-$1" ;;
  logs)    # logs <slug> [tail]
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "usage: logs <slug> [tail]"
    valid_slug "$1"; tail="${2:-200}"; valid_tail "$tail"
    exec "$DOCKER_BIN" logs --tail "$tail" "op-app-$1"
    ;;
  state)   # state <slug> → running | stopped | missing
    [ "$#" -eq 1 ] || die "usage: state <slug>"; valid_slug "$1"
    if status="$("$DOCKER_BIN" inspect -f '{{.State.Status}}' "op-app-$1" 2>/dev/null)"; then
      [ "$status" = "running" ] && echo running || echo stopped
    else
      echo missing
    fi
    ;;
  *) die "unknown verb: ${verb:-<none>}" ;;
esac
