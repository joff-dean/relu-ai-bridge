#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/integrate.sh [옵션] PERFETTO_DIR

옵션:
  --target upstream|company   기본값: upstream
  --expected-head SHA         company 대상에서 필수인 40자리 정확한 HEAD
  --mode copy|symlink         기본값: copy
  --refresh                   관리 중인 기존 overlay를 백업 후 갱신
  --allow-dirty-source        개발 중인 미커밋 소스 overlay 허용
  --allow-anchor-fallback     company patch context가 다를 때 검증된 anchor 삽입 허용
  -h, --help                  도움말

copy는 재현 가능한 빌드/사내 통합용, symlink는 로컬 개발용이다.
company 대상은 copy와 clean RELU source만 허용한다.
비관리 대상 디렉터리나 예상 밖 Perfetto 변경 사항은 덮어쓰지 않는다.
EOF
}

target_kind=upstream
expected_head=
overlay_mode=copy
refresh=0
allow_dirty_source=0
allow_anchor_fallback=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || die "--target 값이 필요합니다"; target_kind=$2; shift 2 ;;
    --expected-head) [ "$#" -ge 2 ] || die "--expected-head 값이 필요합니다"; expected_head=$2; shift 2 ;;
    --mode) [ "$#" -ge 2 ] || die "--mode 값이 필요합니다"; overlay_mode=$2; shift 2 ;;
    --refresh) refresh=1; shift ;;
    --allow-dirty-source) allow_dirty_source=1; shift ;;
    --allow-anchor-fallback) allow_anchor_fallback=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "알 수 없는 옵션: $1" ;;
    *) [ -z "${perfetto_dir:-}" ] || die "PERFETTO_DIR은 하나만 지정하십시오"; perfetto_dir=$1; shift ;;
  esac
done

[ -n "${perfetto_dir:-}" ] || { usage >&2; exit 2; }
case "$target_kind" in upstream|company) ;; *) die "--target은 upstream 또는 company여야 합니다" ;; esac
case "$overlay_mode" in copy|symlink) ;; *) die "--mode는 copy 또는 symlink여야 합니다" ;; esac
if [ "$target_kind" = company ]; then
  [ "$overlay_mode" = copy ] || die "company 대상에는 --mode copy만 허용합니다"
  [ "$allow_dirty_source" -eq 0 ] || die "company 대상에는 --allow-dirty-source를 허용하지 않습니다"
fi

require_command git
require_command python3
require_command cmp
assert_source_layout
perfetto_dir=$(canonical_existing_dir "$perfetto_dir")
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$perfetto_dir"
assert_git_worktree_root "$perfetto_dir"
assert_git_metadata_outside_project_root "$perfetto_dir"

upstream_commit=$(compat_value public_baseline.commit_sha)
if [ "$target_kind" = upstream ]; then
  [ -z "$expected_head" ] || die "upstream 대상에는 --expected-head를 사용하지 않습니다"
  assert_exact_head "$perfetto_dir" "$upstream_commit"
else
  printf '%s\n' "$expected_head" | grep -Eq '^[0-9a-f]{40}$' || \
    die "company 대상에는 내부에서 확인한 40자리 --expected-head가 필요합니다"
  assert_exact_head "$perfetto_dir" "$expected_head"
fi

plugin_rel=$(compat_value integration.target_plugin_path)
adapter_rel=$(compat_value integration.target_adapter_path)
default_plugins_rel=$(compat_value integration.default_plugins_file)
plugin_target="$perfetto_dir/$plugin_rel"
adapter_target="$perfetto_dir/$adapter_rel"
default_plugins_file="$perfetto_dir/$default_plugins_rel"
[ -f "$default_plugins_file" ] || die "Perfetto default plugin 파일이 없습니다: $default_plugins_file"

# 재실행 시 우리가 관리하는 두 경로의 변경만 허용한다.
while IFS= read -r status_line; do
  [ -n "$status_line" ] || continue
  status_path=${status_line#???}
  case "$status_path" in
    "$plugin_rel"|"$plugin_rel"/*|"$adapter_rel"|"$adapter_rel"/*|"$default_plugins_rel") ;;
    *) die "Perfetto 작업공간에 통합 범위 밖 변경이 있습니다: $status_line" ;;
  esac
done <<EOF
$(git -C "$perfetto_dir" status --porcelain --untracked-files=all)
EOF

if [ "$allow_dirty_source" -ne 1 ]; then
  [ -z "$(git -C "$PERFETTO_PROJECT_ROOT" status --porcelain --untracked-files=all)" ] || \
    die "프로젝트 소스가 clean하지 않습니다. 릴리스 checkout을 사용하거나 개발 시 --allow-dirty-source를 지정하십시오"
  ignored_source=$(git -C "$PERFETTO_PROJECT_ROOT" ls-files \
    --others --ignored --exclude-standard -- \
    "$(compat_value integration.source_plugin_path)" \
    "$(compat_value integration.source_adapter_path)")
  [ -z "$ignored_source" ] || \
    die "재현 가능한 copy를 위해 plugin/adapter source의 ignored 파일도 제거해야 합니다"
fi

plugin_source="$PERFETTO_PROJECT_ROOT/$(compat_value integration.source_plugin_path)"
adapter_source="$PERFETTO_PROJECT_ROOT/$(compat_value integration.source_adapter_path)"
stage_parent="$perfetto_dir/ui/src"
[ -d "$stage_parent" ] || die "Perfetto ui/src 디렉터리가 없습니다"
assert_no_symlink_components "$stage_parent" "$perfetto_dir"
assert_no_symlink_components "$plugin_target" "$perfetto_dir"
assert_no_symlink_components "$adapter_target" "$perfetto_dir"
assert_no_symlink_components "$default_plugins_file" "$perfetto_dir"
stage_root=$(mktemp -d "$stage_parent/.relu-ai-bridge-overlay.XXXXXX")
plugin_stage="$stage_root/plugin"
adapter_stage="$stage_root/adapter"
mkdir -p -- "$plugin_stage" "$adapter_stage"
cleanup() {
  if [ -d "$stage_root" ]; then
    rm -rf -- "$stage_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$overlay_mode" = copy ]; then
  cp -R -- "$plugin_source/." "$plugin_stage/"
  cp -R -- "$adapter_source/." "$adapter_stage/"
else
  find "$plugin_source" -mindepth 1 -maxdepth 1 -print | while IFS= read -r source_entry; do
    entry_name=$(basename -- "$source_entry")
    ln -s -- "$source_entry" "$plugin_stage/$entry_name"
  done
  find "$adapter_source" -mindepth 1 -maxdepth 1 -print | while IFS= read -r source_entry; do
    entry_name=$(basename -- "$source_entry")
    ln -s -- "$source_entry" "$adapter_stage/$entry_name"
  done
fi
printf '%s\n' 'managed-by=relu-ai-bridge' "connector=perfetto" "mode=$overlay_mode" \
  > "$plugin_stage/.relu-ai-bridge-managed"
printf '%s\n' 'managed-by=relu-ai-bridge' "connector=perfetto" "mode=$overlay_mode" \
  > "$adapter_stage/.relu-ai-bridge-managed"

preflight_overlay() {
  local label=$1
  local staged=$2
  local target=$3

  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target/.relu-ai-bridge-managed" ] || \
      die "기존 비관리 $label 디렉터리를 덮어쓰지 않습니다: $target"
    if ! diff -qr -- "$staged" "$target" >/dev/null 2>&1; then
      [ "$refresh" -eq 1 ] || \
        die "관리 중인 $label overlay가 다릅니다. 검토 후 --refresh로 갱신하십시오"
    fi
  fi
}

preflight_overlay plugin "$plugin_stage" "$plugin_target"
preflight_overlay adapter "$adapter_stage" "$adapter_target"

plugin_id=$(compat_value integration.plugin_id)
plugin_literal="  '$plugin_id',"
literal_count=$(grep -Fxc "$plugin_literal" "$default_plugins_file" || true)
enable_method=none
if [ "$literal_count" -eq 0 ]; then
  enable_patch="$PERFETTO_PROJECT_ROOT/$(compat_value integration.enable_patch)"
  assert_single_file_patch "$enable_patch" "$default_plugins_rel"
  if git -C "$perfetto_dir" apply --check "$enable_patch" >/dev/null 2>&1; then
    enable_method=patch
  elif [ "$target_kind" = company ] && [ "$allow_anchor_fallback" -eq 1 ]; then
    anchor_count=$(grep -Fxc "  'dev.perfetto.VideoFrames'," "$default_plugins_file" || true)
    [ "$anchor_count" -eq 1 ] || die "안전한 defaultPlugins anchor가 정확히 하나가 아닙니다"
    enable_method=anchor
  else
    die "기본 활성화 patch context가 다릅니다. company 진단 후 필요하면 --allow-anchor-fallback을 명시하십시오"
  fi
elif [ "$literal_count" -gt 1 ]; then
  die "defaultPlugins에 plugin ID가 중복되어 있습니다"
fi

plugin_change=1
adapter_change=1
plugin_had_previous=0
adapter_had_previous=0
if [ -e "$plugin_target" ] || [ -L "$plugin_target" ]; then
  plugin_had_previous=1
  if diff -qr -- "$plugin_stage" "$plugin_target" >/dev/null 2>&1; then
    plugin_change=0
  fi
fi
if [ -e "$adapter_target" ] || [ -L "$adapter_target" ]; then
  adapter_had_previous=1
  if diff -qr -- "$adapter_stage" "$adapter_target" >/dev/null 2>&1; then
    adapter_change=0
  fi
fi

if [ "$plugin_change" -eq 0 ] && [ "$adapter_change" -eq 0 ] && \
   [ "$enable_method" = none ]; then
  info "plugin/adapter overlay와 기본 활성화가 이미 최신입니다"
  "$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"
  info "통합 완료: $perfetto_dir"
  exit 0
fi

backup_root="$(absolute_git_dir "$perfetto_dir")/relu-ai-bridge-backups"
mkdir -p -- "$backup_root"
transaction_backup=$(mktemp -d "$backup_root/integration.XXXXXX")
transaction_active=0
default_backup=

rollback_transaction() {
  local rollback_error=0
  if [ "$transaction_active" -eq 1 ]; then
    if [ -n "$default_backup" ] && [ -f "$default_backup" ] && \
       ! cmp -s "$default_backup" "$default_plugins_file"; then
      default_restore="$default_plugins_file.relu-rollback.$$"
      if ! cp -p -- "$default_backup" "$default_restore" || \
         ! mv -f -- "$default_restore" "$default_plugins_file"; then
        printf '%s\n' '오류: default_plugins.ts 자동 rollback 실패' >&2
        rm -f -- "$default_restore" >/dev/null 2>&1 || true
        rollback_error=1
      fi
    fi
    if [ -e "$transaction_backup/adapter.previous" ] || \
       [ -L "$transaction_backup/adapter.previous" ]; then
      if [ -e "$adapter_target" ] || [ -L "$adapter_target" ]; then
        if ! rm -rf -- "$adapter_target"; then
          printf '%s\n' '오류: 신규 adapter overlay rollback 삭제 실패' >&2
          rollback_error=1
        fi
      fi
      if [ ! -e "$adapter_target" ] && [ ! -L "$adapter_target" ] && \
         ! mv -- "$transaction_backup/adapter.previous" "$adapter_target"; then
        printf '%s\n' '오류: 이전 adapter overlay rollback 복원 실패' >&2
        rollback_error=1
      fi
    elif [ "$adapter_change" -eq 1 ] && [ "$adapter_had_previous" -eq 0 ] && \
         { [ -e "$adapter_target" ] || [ -L "$adapter_target" ]; }; then
      if ! rm -rf -- "$adapter_target"; then
        printf '%s\n' '오류: 신규 adapter overlay rollback 실패' >&2
        rollback_error=1
      fi
    fi
    if [ -e "$transaction_backup/plugin.previous" ] || \
       [ -L "$transaction_backup/plugin.previous" ]; then
      if [ -e "$plugin_target" ] || [ -L "$plugin_target" ]; then
        if ! rm -rf -- "$plugin_target"; then
          printf '%s\n' '오류: 신규 plugin overlay rollback 삭제 실패' >&2
          rollback_error=1
        fi
      fi
      if [ ! -e "$plugin_target" ] && [ ! -L "$plugin_target" ] && \
         ! mv -- "$transaction_backup/plugin.previous" "$plugin_target"; then
        printf '%s\n' '오류: 이전 plugin overlay rollback 복원 실패' >&2
        rollback_error=1
      fi
    elif [ "$plugin_change" -eq 1 ] && [ "$plugin_had_previous" -eq 0 ] && \
         { [ -e "$plugin_target" ] || [ -L "$plugin_target" ]; }; then
      if ! rm -rf -- "$plugin_target"; then
        printf '%s\n' '오류: 신규 plugin overlay rollback 실패' >&2
        rollback_error=1
      fi
    fi
  fi
  if [ -d "$stage_root" ] && ! rm -rf -- "$stage_root"; then
    printf '%s\n' '오류: integration stage 정리 실패' >&2
    rollback_error=1
  fi
  if [ "$rollback_error" -ne 0 ]; then
    printf '오류: 수동 복구용 backup: %s\n' "$transaction_backup" >&2
  fi
}
trap rollback_transaction EXIT
trap 'exit 130' INT TERM

if [ "$plugin_change" -eq 0 ]; then info "plugin overlay가 이미 최신입니다"; fi
if [ "$adapter_change" -eq 0 ]; then info "adapter overlay가 이미 최신입니다"; fi

transaction_active=1
if [ "$enable_method" != none ]; then
  default_backup="$transaction_backup/default_plugins.ts.previous"
  cp -p -- "$default_plugins_file" "$default_backup"
fi
if [ "$plugin_change" -eq 1 ]; then
  mkdir -p -- "$(dirname -- "$plugin_target")"
  if [ "$plugin_had_previous" -eq 1 ]; then
    mv -- "$plugin_target" "$transaction_backup/plugin.previous"
  fi
  mv -- "$plugin_stage" "$plugin_target"
fi
if [ "$adapter_change" -eq 1 ]; then
  mkdir -p -- "$(dirname -- "$adapter_target")"
  if [ "$adapter_had_previous" -eq 1 ]; then
    mv -- "$adapter_target" "$transaction_backup/adapter.previous"
  fi
  mv -- "$adapter_stage" "$adapter_target"
fi

case "$enable_method" in
  patch)
    git -C "$perfetto_dir" apply "$enable_patch"
    info "v58.2 기본 활성화 patch를 적용했습니다"
    ;;
  anchor)
    python3 - "$default_plugins_file" "$plugin_literal" <<'PY'
from pathlib import Path
import os
import stat
import sys
import tempfile

path = Path(sys.argv[1])
literal = sys.argv[2]
anchor = "  'dev.perfetto.VideoFrames',"
text = path.read_text(encoding="utf-8")
if text.count(anchor) != 1:
    raise SystemExit("안전한 anchor가 정확히 하나가 아니므로 중단합니다")
if literal in text:
    raise SystemExit("plugin literal이 예상하지 않은 형태로 이미 존재합니다")
updated = text.replace(anchor, f"{anchor}\n{literal}", 1)
fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(updated)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
    os.replace(temporary, path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
    info "검토 승인된 anchor fallback으로 기본 활성화를 적용했습니다"
    ;;
  none) info "plugin이 이미 기본 활성화되어 있습니다" ;;
esac

"$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"
transaction_active=0
info "통합 rollback 백업: $transaction_backup"
info "통합 완료: $perfetto_dir"
