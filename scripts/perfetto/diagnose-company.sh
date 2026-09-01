#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법: scripts/perfetto/diagnose-company.sh COMPANY_PERFETTO_DIR [OUTPUT_FILE]

회사 Perfetto HEAD와 공개 v57.2 기준선의 ancestry 및 통합 영향 파일을 진단한다.
기준 commit 객체가 사내 저장소에 미리 존재해야 하며 네트워크 fetch는 하지 않는다.
OUTPUT_FILE을 생략하면 stdout으로만 출력한다.
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage >&2; exit 2; }
require_command git
assert_compatibility_alignment
company_dir=$(canonical_existing_dir "$1")
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$company_dir"
assert_git_worktree_root "$company_dir"
assert_git_metadata_outside_project_root "$company_dir"
output_file=${2:-}
if [ -n "$output_file" ]; then
  assert_destination_outside_project_root "$output_file"
fi
baseline=$(compat_value public_baseline.commit_sha)
company_head=$(git -C "$company_dir" rev-parse HEAD)
git -C "$company_dir" cat-file -e "$baseline^{commit}" 2>/dev/null || \
  die "공개 기준 commit 객체가 없습니다. 검증된 upstream v57.2 bundle을 사내로 먼저 반입하십시오: $baseline"

set +e
git -C "$company_dir" merge-base --is-ancestor "$baseline" "$company_head"
ancestor_status=$?
set -e
case "$ancestor_status" in
  0)
    ancestry=direct-descendant
    comparison="$baseline..$company_head"
    ;;
  1)
    ancestry=not-direct-descendant
    merge_base=$(git -C "$company_dir" merge-base "$baseline" "$company_head" 2>/dev/null || true)
    [ -n "$merge_base" ] || merge_base=none
    # merge-base가 없어도 두 tree의 실제 integration-sensitive diff는 남긴다.
    comparison="$baseline..$company_head"
    ;;
  *) die "Git ancestry 계산 중 오류가 발생했습니다" ;;
esac

report_file=$(mktemp /tmp/relu-ai-bridge-company-diagnosis.XXXXXX)
cleanup() { rm -f -- "$report_file"; }
trap cleanup EXIT INT TERM
{
  printf 'RELU AI Bridge Connector #1 사내 Perfetto 호환성 진단\n'
  printf '========================================\n'
  printf 'baseline_commit=%s\n' "$baseline"
  printf 'company_head=%s\n' "$company_head"
  printf 'ancestry=%s\n' "$ancestry"
  if [ "${merge_base:-}" ]; then printf 'merge_base=%s\n' "$merge_base"; fi
  printf 'comparison=%s\n\n' "$comparison"

  printf '[통합 민감 경로 변경]\n'
  git -c core.quotePath=true -C "$company_dir" diff --name-status "$comparison" -- \
    ui/src/public \
    ui/src/core/embedder/default_plugins.ts \
    ui/src/core/plugin_manager.ts \
    ui/src/virtual/plugins.d.ts \
    ui/vite.config.mjs \
    ui/build.mjs || true
  printf '\n[전체 변경 통계]\n'
  git -c core.quotePath=true -C "$company_dir" diff --stat "$comparison" || true
  printf '\n[판정 지침]\n'
  printf '%s\n' '- direct-descendant여도 API 호환성을 보장하지 않는다.'
  printf '%s\n' '- 통합 민감 경로가 바뀌었으면 company-only adapter에서만 흡수한다.'
  printf '%s\n' '- 실제 trace, 사내 경로, 제품명, 이슈 번호는 외부 저장소로 복사하지 않는다.'
} > "$report_file"

if [ -n "$output_file" ]; then
  assert_path_absent "$output_file"
  cp -- "$report_file" "$output_file"
fi
cat "$report_file"
