#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

case "${1:-}" in -h|--help)
  printf '%s\n' '사용법: scripts/perfetto/verify-integration.sh PERFETTO_DIR'
  exit 0
;; esac
[ "$#" -eq 1 ] || die "사용법: scripts/perfetto/verify-integration.sh PERFETTO_DIR"
require_command git
assert_compatibility_alignment
perfetto_dir=$(canonical_existing_dir "$1")
assert_git_worktree_root "$perfetto_dir"
assert_git_metadata_outside_project_root "$perfetto_dir"

plugin_rel=$(compat_value integration.target_plugin_path)
adapter_rel=$(compat_value integration.target_adapter_path)
default_plugins_rel=$(compat_value integration.default_plugins_file)
plugin_id=$(compat_value integration.plugin_id)

[ -f "$perfetto_dir/$plugin_rel/index.ts" ] || die "통합 plugin index.ts가 없습니다"
[ -f "$perfetto_dir/$adapter_rel/protocol.ts" ] || die "통합 adapter protocol.ts가 없습니다"
[ -d "$perfetto_dir/$adapter_rel/v57" ] || die "통합 v57 adapter가 없습니다"
[ -f "$perfetto_dir/$plugin_rel/.relu-ai-bridge-managed" ] || die "overlay 관리 표식이 없습니다"
[ -f "$perfetto_dir/$adapter_rel/.relu-ai-bridge-managed" ] || die "adapter overlay 관리 표식이 없습니다"
[ -f "$perfetto_dir/$default_plugins_rel" ] || die "default_plugins.ts가 없습니다"
[ ! -e "$perfetto_dir/ui/src/plugins/io.company.PerfettoLocalAI" ] || \
  die "이전 Perfetto plugin ID overlay가 남아 있습니다"
! grep -Fq "'io.company.PerfettoLocalAI'" "$perfetto_dir/$default_plugins_rel" || \
  die "defaultPlugins에 이전 Perfetto plugin ID가 남아 있습니다"

count=$(grep -Fxc "  '$plugin_id'," "$perfetto_dir/$default_plugins_rel" || true)
[ "$count" -eq 1 ] || die "defaultPlugins의 $plugin_id 항목 수가 1이 아닙니다: $count"

id_literal_count=$(grep -F "'$plugin_id'" "$perfetto_dir/$plugin_rel/index.ts" | wc -l | tr -d ' ')
[ "$id_literal_count" -ge 1 ] || die "plugin index.ts의 ID가 compatibility contract와 다릅니다"
grep -Eq 'static readonly id = (PLUGIN_ID|.io\.company\.RELUPerfettoBridge.);' \
  "$perfetto_dir/$plugin_rel/index.ts" || die "plugin static id 선언을 확인할 수 없습니다"

info "통합 구조 검증 통과"
info "plugin: $plugin_rel"
info "adapter: $adapter_rel (contract v57)"
