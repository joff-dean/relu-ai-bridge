#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법: scripts/perfetto/build-test.sh [옵션] PERFETTO_DIR

옵션:
  --install-deps   tools/install-build-deps --ui를 먼저 실행(네트워크 가능 환경)
  --typecheck      TypeScript typecheck만 실행(기본값)
  --build          UI production build 실행
  --unit-tests     UI unit test 실행
  --all-tests      UI build, unit test, integration test 실행
  -h, --help       도움말
EOF
}

install_deps=0
mode=typecheck
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-deps) install_deps=1; shift ;;
    --typecheck) mode=typecheck; shift ;;
    --build) mode=build; shift ;;
    --unit-tests) mode=unit-tests; shift ;;
    --all-tests) mode=all-tests; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "알 수 없는 옵션: $1" ;;
    *) [ -z "${perfetto_dir:-}" ] || die "PERFETTO_DIR은 하나만 지정하십시오"; perfetto_dir=$1; shift ;;
  esac
done
[ -n "${perfetto_dir:-}" ] || { usage >&2; exit 2; }

perfetto_dir=$(canonical_existing_dir "$perfetto_dir")
"$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"

if [ "$install_deps" -eq 1 ]; then
  [ -x "$perfetto_dir/tools/install-build-deps" ] || die "install-build-deps를 찾을 수 없습니다"
  "$perfetto_dir/tools/install-build-deps" --ui
fi
assert_perfetto_node "$perfetto_dir"

case "$mode" in
  typecheck) "$perfetto_dir/ui/build" --typecheck ;;
  build) "$perfetto_dir/ui/build" ;;
  unit-tests) "$perfetto_dir/ui/run-unittests" ;;
  all-tests) "$perfetto_dir/ui/run-all-tests" ;;
esac
info "Perfetto UI $mode 완료"
