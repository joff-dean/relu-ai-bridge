#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

case "${1:-}" in -h|--help)
  printf '%s\n' '사용법: scripts/perfetto/run-dev-server.sh PERFETTO_DIR [Perfetto 옵션...]'
  exit 0
;; esac
[ "$#" -ge 1 ] || die "사용법: scripts/perfetto/run-dev-server.sh PERFETTO_DIR [Perfetto 옵션...]"
perfetto_dir=$(canonical_existing_dir "$1")
shift
"$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"
assert_perfetto_node "$perfetto_dir"
exec "$perfetto_dir/ui/run-dev-server" "$@"
