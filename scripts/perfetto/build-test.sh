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
  --target upstream|company   기본값: upstream
  --expected-head SHA         company 대상에서 필수인 40자리 정확한 HEAD
  --company-adapter-dir DIR   적용된 사내 adapter의 승인 원본 디렉터리
  --expected-company-adapter-sha256 SHA256
                              사내 adapter 외부 승인 payload digest
  -h, --help       도움말
EOF
}

install_deps=0
mode=typecheck
target_kind=upstream
expected_head=
company_adapter_dir=
expected_company_adapter_sha256=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-deps) install_deps=1; shift ;;
    --typecheck) mode=typecheck; shift ;;
    --build) mode=build; shift ;;
    --unit-tests) mode=unit-tests; shift ;;
    --all-tests) mode=all-tests; shift ;;
    --target) [ "$#" -ge 2 ] || die "--target 값이 필요합니다"; target_kind=$2; shift 2 ;;
    --expected-head) [ "$#" -ge 2 ] || die "--expected-head 값이 필요합니다"; expected_head=$2; shift 2 ;;
    --company-adapter-dir)
      [ "$#" -ge 2 ] || die "--company-adapter-dir 값이 필요합니다"
      company_adapter_dir=$2
      shift 2
      ;;
    --expected-company-adapter-sha256)
      [ "$#" -ge 2 ] || die "--expected-company-adapter-sha256 값이 필요합니다"
      expected_company_adapter_sha256=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    --*) die "알 수 없는 옵션: $1" ;;
    *) [ -z "${perfetto_dir:-}" ] || die "PERFETTO_DIR은 하나만 지정하십시오"; perfetto_dir=$1; shift ;;
  esac
done
[ -n "${perfetto_dir:-}" ] || { usage >&2; exit 2; }

assert_perfetto_build_host
perfetto_dir=$(canonical_existing_dir "$perfetto_dir")
verify_arguments=(--target "$target_kind")
if [ -n "$expected_head" ]; then verify_arguments+=(--expected-head "$expected_head"); fi
if [ -n "$company_adapter_dir" ]; then
  verify_arguments+=(--company-adapter-dir "$company_adapter_dir")
fi
if [ -n "$expected_company_adapter_sha256" ]; then
  verify_arguments+=(--expected-company-adapter-sha256 "$expected_company_adapter_sha256")
fi
"$SCRIPT_DIR/verify-integration.sh" "${verify_arguments[@]}" "$perfetto_dir"

if [ "$install_deps" -eq 1 ]; then
  [ -x "$perfetto_dir/tools/install-build-deps" ] || die "install-build-deps를 찾을 수 없습니다"
  set +e
  "$perfetto_dir/tools/install-build-deps" --ui
  install_status=$?
  set -e
  set +e
  post_install_output=$("$SCRIPT_DIR/verify-integration.sh" \
    "${verify_arguments[@]}" "$perfetto_dir" 2>&1)
  post_install_status=$?
  set -e
  if [ "$post_install_status" -ne 0 ]; then
    printf '%s\n' "$post_install_output" >&2
    die "dependency installer가 integration source 계약을 변경했습니다"
  fi
  if [ "$install_status" -ne 0 ]; then
    printf '오류: Perfetto dependency installer 실패(exit %s)\n' "$install_status" >&2
    exit "$install_status"
  fi
fi
assert_perfetto_node "$perfetto_dir"

# Dependency output은 허용하지만 build input은 설치 완료 뒤 다시 고정한다.
"$SCRIPT_DIR/verify-integration.sh" "${verify_arguments[@]}" "$perfetto_dir"
before_fingerprint=$("$SCRIPT_DIR/verify-integration.sh" \
  "${verify_arguments[@]}" --fingerprint "$perfetto_dir")

set +e
case "$mode" in
  typecheck) "$perfetto_dir/ui/build" --typecheck ;;
  build) "$perfetto_dir/ui/build" ;;
  unit-tests) "$perfetto_dir/ui/run-unittests" ;;
  all-tests) "$perfetto_dir/ui/run-all-tests" ;;
esac
command_status=$?
post_output=$("$SCRIPT_DIR/verify-integration.sh" \
  "${verify_arguments[@]}" "$perfetto_dir" 2>&1)
post_status=$?
set -e

# Build/test가 실패해도 사후 검증을 생략하지 않는다. 성공/실패 모두 같은 exact
# HEAD, committed RELU source, adapter source, overlay/default-plugin 계약을 재계산한다.
if [ "$post_status" -ne 0 ]; then
  printf '%s\n' "$post_output" >&2
  die "Perfetto UI $mode 실행 뒤 integration 계약이 변경되었습니다"
fi
printf '%s\n' "$post_output"
after_fingerprint=$("$SCRIPT_DIR/verify-integration.sh" \
  "${verify_arguments[@]}" --fingerprint "$perfetto_dir")
[ "$before_fingerprint" = "$after_fingerprint" ] || \
  die "Perfetto UI $mode 실행 중 build input fingerprint가 변경되었습니다"
if [ "$command_status" -ne 0 ]; then
  printf '오류: Perfetto UI %s 실패(exit %s)\n' "$mode" "$command_status" >&2
  exit "$command_status"
fi
info "Perfetto UI $mode 완료"
