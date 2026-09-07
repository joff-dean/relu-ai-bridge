#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

case "${1:-}" in -h|--help)
  printf '%s\n' '사용법: scripts/perfetto/run-local-stack.sh PERFETTO_DIR [--instances N] [--ui-port PORT] [--upstream-port PORT] [--bridge-port PORT]'
  exit 0
;; esac
[ "$#" -ge 1 ] || die "사용법: scripts/perfetto/run-local-stack.sh PERFETTO_DIR [options]"
assert_perfetto_build_host
perfetto_dir=$(canonical_existing_dir "$1")
shift
"$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"
assert_perfetto_node "$perfetto_dir"
official_codex='/Applications/ChatGPT.app/Contents/Resources/codex'
codex_args=()
if [ "$(uname -s)" = 'Darwin' ] && [ -f "$official_codex" ] && [ ! -L "$official_codex" ] \
  && /usr/bin/codesign --verify --strict "$official_codex" >/dev/null 2>&1; then
  codex_identity=$(/usr/bin/codesign -dv --verbose=4 "$official_codex" 2>&1 || true)
  case "$codex_identity" in
    *'Identifier=codex'*'TeamIdentifier=2DC432GLL2'*)
      "$perfetto_dir/ui/node" "$SCRIPT_DIR/register-codex.mjs" "$official_codex" "$perfetto_dir/ui/node"
      codex_args=(--codex-cli "$official_codex")
      ;;
  esac
fi

exec "$perfetto_dir/ui/node" "$SCRIPT_DIR/run-local-stack.mjs" "$perfetto_dir" "$@" "${codex_args[@]}"
