#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/overlay-company-adapter.sh [--refresh] \
    COMPANY_ADAPTER_DIR COMPANY_PERFETTO_DIR EXPECTED_HEAD EXPECTED_ADAPTER_SHA256
  scripts/perfetto/overlay-company-adapter.sh --print-source-sha256 COMPANY_ADAPTER_DIR

COMPANY_ADAPTER_DIR은 반드시 이 외부 프로젝트 checkout 밖에 있어야 하며,
다음 COMPANY_ADAPTER.json을 포함해야 한다.
  {"schema_version":1,"company_perfetto_commit":"40자리 SHA","base_adapter":"v58"}

기본 v58 adapter를 .git/relu-ai-bridge-backups에 백업한 뒤 내부 adapter로 교체한다.
EXPECTED_ADAPTER_SHA256는 별도 검토·승인한 payload inventory SHA-256이다.
EOF
}

company_adapter_payload_digest() {
  python3 - "$1" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys
import unicodedata

root = pathlib.Path(sys.argv[1])
inventory = {}
seen = {}
for current, directories, files in os.walk(root, topdown=True, followlinks=False):
    current_path = pathlib.Path(current)
    for directory in directories:
        candidate = current_path / directory
        if candidate.is_symlink():
            raise SystemExit(f"company adapter directory symlink: {candidate}")
    for filename in files:
        candidate = current_path / filename
        relative = candidate.relative_to(root).as_posix()
        if relative == "COMPANY_ADAPTER.json":
            continue
        if candidate.is_symlink() or not candidate.is_file():
            raise SystemExit(f"company adapter non-regular file: {relative}")
        key = unicodedata.normalize("NFC", relative).casefold()
        if key in seen and seen[key] != relative:
            raise SystemExit(f"company adapter case/Unicode collision: {seen[key]} / {relative}")
        seen[key] = relative
        metadata = candidate.stat()
        content = candidate.read_bytes()
        inventory[relative] = (
            hashlib.sha256(content).hexdigest(),
            len(content),
            1 if stat.S_IMODE(metadata.st_mode) & 0o111 else 0,
        )
if "index.ts" not in inventory:
    raise SystemExit("company adapter index.ts가 없습니다")
encoded = json.dumps(
    inventory,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
print(hashlib.sha256(encoded).hexdigest())
PY
}

if [ "${1:-}" = --print-source-sha256 ]; then
  [ "$#" -eq 2 ] || { usage >&2; exit 2; }
  require_command python3
  digest_source=$(canonical_existing_dir "$2")
  assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$digest_source"
  company_adapter_payload_digest "$digest_source"
  exit 0
fi

refresh=0
case "${1:-}" in --refresh) refresh=1; shift ;; -h|--help) usage; exit 0 ;; esac
[ "$#" -eq 4 ] || { usage >&2; exit 2; }
require_command git
require_command python3
assert_compatibility_alignment

company_adapter=$(canonical_existing_dir "$1")
company_perfetto=$(canonical_existing_dir "$2")
expected_head=$3
expected_adapter_sha256=$4
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$company_adapter"
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$company_perfetto"
assert_disjoint_trees "$company_adapter" "$company_perfetto"
printf '%s\n' "$expected_head" | grep -Eq '^[0-9a-f]{40}$' || die "EXPECTED_HEAD는 40자리 SHA여야 합니다"
printf '%s\n' "$expected_adapter_sha256" | grep -Eq '^[0-9a-f]{64}$' || \
  die "EXPECTED_ADAPTER_SHA256는 64자리 SHA-256이어야 합니다"
assert_git_worktree_root "$company_perfetto"
assert_git_metadata_outside_project_root "$company_perfetto"
assert_exact_head "$company_perfetto" "$expected_head"
[ -f "$company_adapter/COMPANY_ADAPTER.json" ] || die "COMPANY_ADAPTER.json이 없습니다"
[ -f "$company_adapter/index.ts" ] || die "company adapter는 완전한 v58 교체본이며 index.ts가 필요합니다"
company_symlink=$(find "$company_adapter" -type l -print -quit)
[ -z "$company_symlink" ] || die "company adapter source에 symlink를 허용하지 않습니다: $company_symlink"
company_forbidden=$(find "$company_adapter" \( \
  -name .git -o -name node_modules -o -name '.env*' -o \
  -name '*.pftrace' -o -name '*.perfetto-trace' -o -name '*.trace' -o \
  -name '*.pem' -o -name '*.p12' -o -name '*.pfx' -o -name '*.key' \
  \) -print -quit)
[ -z "$company_forbidden" ] || \
  die "company adapter source에 복사 금지 항목이 있습니다: $company_forbidden"

manifest_commit=$(python3 - "$company_adapter/COMPANY_ADAPTER.json" <<'PY'
import json
import pathlib
import re
import sys

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SystemExit("company adapter manifest duplicate key")
        result[key] = value
    return result

data = json.loads(
    pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"),
    object_pairs_hook=reject_duplicates,
)
if not isinstance(data, dict) or set(data) != {
    "schema_version", "company_perfetto_commit", "base_adapter"
}:
    raise SystemExit("company adapter manifest field contract 불일치")
if data.get("schema_version") != 1 or data.get("base_adapter") != "v58":
    raise SystemExit("company adapter manifest contract 불일치")
commit = data.get("company_perfetto_commit", "")
if not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("company_perfetto_commit은 40자리 SHA여야 함")
print(commit)
PY
) || die "COMPANY_ADAPTER.json 검증 실패"
[ "$manifest_commit" = "$expected_head" ] || die "adapter 대상 commit과 실제 company HEAD가 다릅니다"
actual_adapter_sha256=$(company_adapter_payload_digest "$company_adapter") || \
  die "company adapter payload digest 계산 실패"
[ "$actual_adapter_sha256" = "$expected_adapter_sha256" ] || \
  die "company adapter payload가 외부 승인 SHA-256과 다릅니다"

plugin_rel=$(compat_value integration.target_plugin_path)
adapter_rel=$(compat_value integration.target_adapter_path)
plugin_target="$company_perfetto/$plugin_rel"
adapter_root="$company_perfetto/$adapter_rel"
adapter_target="$adapter_root/v58"
[ -f "$plugin_target/.relu-ai-bridge-managed" ] || die "generic plugin 통합을 먼저 실행하십시오"
[ -f "$adapter_root/.relu-ai-bridge-managed" ] || die "generic adapter 통합을 먼저 실행하십시오"
[ -d "$adapter_target" ] || die "generic v58 adapter 통합을 먼저 실행하십시오"
assert_no_symlink_components "$plugin_target" "$company_perfetto"
assert_no_symlink_components "$adapter_target" "$company_perfetto"

stage_parent=$(dirname -- "$adapter_target")
stage_dir=$(mktemp -d "$stage_parent/.company-adapter.XXXXXX")
transaction_active=0
backup_path=
cleanup() {
  local rollback_error=0
  if [ "$transaction_active" -eq 1 ]; then
    if [ -n "$backup_path" ] && \
       { [ -e "$backup_path" ] || [ -L "$backup_path" ]; }; then
      if [ -e "$adapter_target" ] || [ -L "$adapter_target" ]; then
        if ! rm -rf -- "$adapter_target"; then
          printf '%s\n' '오류: 신규 company adapter rollback 삭제 실패' >&2
          rollback_error=1
        fi
      fi
      if [ ! -e "$adapter_target" ] && [ ! -L "$adapter_target" ] && \
         ! mv -- "$backup_path" "$adapter_target"; then
        printf '%s\n' '오류: 이전 adapter rollback 복원 실패' >&2
        rollback_error=1
      fi
    fi
  fi
  if [ -d "$stage_dir" ] && ! rm -rf -- "$stage_dir"; then
    printf '%s\n' '오류: company adapter stage 정리 실패' >&2
    rollback_error=1
  fi
  if [ "$rollback_error" -ne 0 ]; then
    printf '오류: 수동 복구용 backup: %s\n' "${backup_path:-not-created}" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cp -R -- "$company_adapter/." "$stage_dir/"
rm -f -- "$stage_dir/COMPANY_ADAPTER.json"
printf '%s\n' 'managed-by=company-internal-adapter' "company-perfetto-commit=$expected_head" \
  > "$stage_dir/.company-adapter-applied"

if [ -f "$adapter_target/.company-adapter-applied" ] && \
   diff -qr -- "$stage_dir" "$adapter_target" >/dev/null 2>&1; then
  rm -rf -- "$stage_dir"
  info "company adapter가 이미 최신입니다"
  exit 0
fi
[ ! -f "$adapter_target/.company-adapter-applied" ] || [ "$refresh" -eq 1 ] || \
  die "기존 company adapter와 다릅니다. 검토 후 --refresh를 지정하십시오"

backup_root="$(absolute_git_dir "$company_perfetto")/relu-ai-bridge-backups"
mkdir -p -- "$backup_root"
backup_dir=$(mktemp -d "$backup_root/adapter-v58.XXXXXX")
backup_path="$backup_dir/previous"
transaction_active=1
mv -- "$adapter_target" "$backup_path"
mv -- "$stage_dir" "$adapter_target"
[ -f "$adapter_target/index.ts" ] || die "company adapter 설치 후 index.ts가 없습니다"
[ -f "$adapter_target/.company-adapter-applied" ] || die "company adapter 관리 표식이 없습니다"
"$SCRIPT_DIR/verify-integration.sh" --target company \
  --expected-head "$expected_head" --company-adapter-dir "$company_adapter" \
  --expected-company-adapter-sha256 "$expected_adapter_sha256" \
  "$company_perfetto"
transaction_active=0
info "company-only adapter 적용 완료"
info "이전 adapter 백업: $backup_dir"
