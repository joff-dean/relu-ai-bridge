#!/usr/bin/env bash

# 이 파일은 단독 실행하지 않고 같은 디렉터리의 스크립트에서 source 한다.

set -euo pipefail

# 호출자의 Git plumbing 환경이 검역/대상 저장소를 우회하지 못하게 한다.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_SHALLOW_FILE
unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
export GIT_NO_REPLACE_OBJECTS=1

PERFETTO_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PERFETTO_PROJECT_ROOT=$(CDPATH= cd -- "$PERFETTO_SCRIPT_DIR/../.." && pwd -P)
RELU_COMPAT_FILE="$PERFETTO_PROJECT_ROOT/compat/relu-ai-bridge.json"
PERFETTO_COMPAT_FILE="$PERFETTO_PROJECT_ROOT/compat/connectors/perfetto-v57.2.json"

die() {
  printf '오류: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[perfetto] %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "필수 명령을 찾을 수 없습니다: $1"
}

compat_value() {
  local dotted_path=$1
  require_command python3
  python3 - "$PERFETTO_COMPAT_FILE" "$dotted_path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
if value is None:
    raise SystemExit(2)
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

relu_value() {
  local dotted_path=$1
  require_command python3
  python3 - "$RELU_COMPAT_FILE" "$dotted_path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
if value is None:
    raise SystemExit(2)
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

assert_compatibility_alignment() {
  require_command python3
  python3 - "$RELU_COMPAT_FILE" "$PERFETTO_COMPAT_FILE" <<'PY'
import json
import pathlib
import sys

relu = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
perfetto = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
if relu.get("product") != {
    "id": "relu-ai-bridge",
    "name": "RELU AI Bridge",
    "core_version": "0.4.0",
    "scope": "company-internal-local-capability-ai-bridge",
}:
    raise SystemExit("RELU AI Bridge core compatibility contract 불일치")
if relu.get("release") != {
    "tag_prefix": "relu-ai-bridge-v",
    "immutable_ref_namespace": "refs/releases/relu-ai-bridge/",
}:
    raise SystemExit("RELU release namespace contract 불일치")
entries = relu.get("connectors", [])
if len(entries) != 1:
    raise SystemExit("현재 release tool은 Connector #1 하나를 요구합니다")
entry = entries[0]
contract = perfetto["connector"]
for core_key, connector_key in (
    ("number", "number"),
    ("id", "id"),
    ("name", "name"),
    ("version", "version"),
    ("contract", "adapter_contract"),
):
    if entry.get(core_key) != contract.get(connector_key):
        raise SystemExit(f"core/connector compatibility 불일치: {core_key}")
if entry.get("manifest") != "connectors/perfetto-v57.2.json":
    raise SystemExit("Perfetto connector manifest 경로 불일치")
core_version = relu["product"]["core_version"]
if contract.get("version") != core_version:
    raise SystemExit("Perfetto connector version과 RELU core version 불일치")
if core_version not in contract.get("compatible_relu_core_versions", []):
    raise SystemExit("Perfetto connector가 RELU core version을 지원하지 않습니다")
expected_baseline = {
    "repository": "https://github.com/google/perfetto.git",
    "release": "v57.2",
    "tag_ref": "refs/tags/v57.2",
    "tag_object_sha": "24bdfb9dfa2dc92883761426dd94259756fa197e",
    "commit_sha": "da1d152cff27890903d158fe96751de3aab883cc",
    "short_commit": "da1d152",
}
if perfetto.get("public_baseline") != expected_baseline:
    raise SystemExit("공식 Perfetto v57.2 exact baseline contract 불일치")
expected_integration = {
    "plugin_id": "io.company.RELUPerfettoBridge",
    "source_plugin_path": "plugin/io.company.RELUPerfettoBridge",
    "source_adapter_path": "perfetto_adapter",
    "target_plugin_path": "ui/src/plugins/io.company.RELUPerfettoBridge",
    "target_adapter_path": "ui/src/perfetto_adapter",
    "default_plugins_file": "ui/src/core/embedder/default_plugins.ts",
    "enable_patch": "integration/patches/perfetto-v57.2-enable-default-plugin.patch",
}
if perfetto.get("integration") != expected_integration:
    raise SystemExit("Perfetto Connector #1 overlay contract 불일치")
if perfetto.get("company_integration_policy") != {
    "metadata_scope": "company-internal-only",
    "exact_head_required": True,
    "company_adapter_must_be_external": True,
    "external_release_metadata_allowed": False,
}:
    raise SystemExit("외부/회사 Perfetto integration 분리 contract 불일치")
if perfetto.get("security_policy") != {
    "company_source_allowed_in_external_repository": False,
    "company_trace_allowed_in_external_repository": False,
    "credential_allowed_in_release_bundle": False,
    "telemetry_allowed": False,
    "runtime_remote_code_loading_allowed": False,
}:
    raise SystemExit("Perfetto connector security policy 불일치")
PY
}

canonical_existing_dir() {
  local target=$1
  [ -d "$target" ] || die "디렉터리가 없습니다: $target"
  (CDPATH= cd -- "$target" && pwd -P)
}

assert_path_absent() {
  local target=$1
  [ ! -e "$target" ] && [ ! -L "$target" ] || \
    die "기존 경로를 덮어쓰지 않습니다: $target"
}

assert_git_repository() {
  local repository=$1
  git -C "$repository" rev-parse --git-dir >/dev/null 2>&1 || \
    die "Git 저장소가 아닙니다: $repository"
}

assert_git_worktree_root() {
  local repository=$1
  local canonical_repository
  local top_level
  assert_git_repository "$repository"
  [ "$(git -C "$repository" rev-parse --is-bare-repository)" = false ] || \
    die "bare 저장소를 작업공간 대상으로 사용할 수 없습니다: $repository"
  canonical_repository=$(canonical_existing_dir "$repository")
  top_level=$(git -C "$canonical_repository" rev-parse --show-toplevel)
  top_level=$(canonical_existing_dir "$top_level")
  [ "$canonical_repository" = "$top_level" ] || \
    die "저장소 최상위 디렉터리를 정확히 지정해야 합니다: $top_level"
}

# 외부 checkout이 linked worktree인 경우 .git 파일은 전혀 다른 저장소의
# git-dir/common-dir를 가리킬 수 있다. 두 metadata tree가 RELU source와
# 중첩되면 fetch, backup, hook/config 조회가 외부 source 경계를 오염시킨다.
assert_git_metadata_outside_project_root() {
  local repository=$1
  local git_dir
  local common_dir
  assert_git_worktree_root "$repository"
  git_dir=$(git -C "$repository" rev-parse --absolute-git-dir)
  common_dir=$(git -C "$repository" rev-parse --path-format=absolute --git-common-dir)
  git_dir=$(canonical_existing_dir "$git_dir")
  common_dir=$(canonical_existing_dir "$common_dir")
  assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$git_dir"
  assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$common_dir"
}

assert_single_file_patch() {
  local patch_file=$1
  local expected_path=$2
  local numstat
  local expected_numstat
  local summary
  [ -f "$patch_file" ] && [ ! -L "$patch_file" ] || \
    die "활성화 patch는 symlink가 아닌 일반 파일이어야 합니다: $patch_file"
  numstat=$(git apply --numstat "$patch_file") || \
    die "활성화 patch 구조를 읽을 수 없습니다"
  expected_numstat=$(printf '1\t0\t%s' "$expected_path")
  [ "$numstat" = "$expected_numstat" ] || \
    die "활성화 patch는 $expected_path 한 줄 추가만 허용합니다"
  summary=$(git apply --summary "$patch_file") || \
    die "활성화 patch summary를 읽을 수 없습니다"
  [ -z "$summary" ] || \
    die "활성화 patch에 rename/mode/create/delete 변경을 허용하지 않습니다"
}

assert_outside_project_root() {
  local target=$1
  local canonical_target
  canonical_target=$(canonical_existing_dir "$target")
  case "$canonical_target/" in
    "$PERFETTO_PROJECT_ROOT/"|"$PERFETTO_PROJECT_ROOT/"*)
      die "외부 프로젝트 경계 안의 경로를 사용할 수 없습니다: $canonical_target"
      ;;
  esac
}

assert_destination_outside_project_root() {
  local target=$1
  local canonical_target
  require_command python3
  canonical_target=$(python3 - "$target" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve(strict=False))
PY
)
  case "$canonical_target/" in
    "$PERFETTO_PROJECT_ROOT/"|"$PERFETTO_PROJECT_ROOT/"*)
      die "외부 프로젝트 경계 안에 경로를 만들 수 없습니다: $canonical_target"
      ;;
  esac
  case "$PERFETTO_PROJECT_ROOT/" in
    "$canonical_target/"|"$canonical_target/"*)
      die "외부 프로젝트를 포함하는 상위 tree를 사용할 수 없습니다: $canonical_target"
      ;;
  esac
}

assert_disjoint_trees() {
  local first=$1
  local second=$2
  local canonical_first
  local canonical_second
  canonical_first=$(canonical_existing_dir "$first")
  canonical_second=$(canonical_existing_dir "$second")
  case "$canonical_first/" in
    "$canonical_second/"|"$canonical_second/"*)
      die "source와 target tree가 같거나 중첩됩니다: $canonical_first / $canonical_second"
      ;;
  esac
  case "$canonical_second/" in
    "$canonical_first/"|"$canonical_first/"*)
      die "source와 target tree가 같거나 중첩됩니다: $canonical_first / $canonical_second"
      ;;
  esac
}

assert_no_symlink_components() {
  local target=$1
  local boundary=$2
  require_command python3
  python3 - "$target" "$boundary" <<'PY'
import os
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
boundary = pathlib.Path(sys.argv[2]).resolve(strict=True)
if not target.is_absolute():
    target = pathlib.Path.cwd() / target
target = target.absolute()
try:
    relative = target.relative_to(boundary)
except ValueError:
    raise SystemExit(f"대상 경로가 검증 경계 밖입니다: {target}")
current = boundary
for component in relative.parts:
    current = current / component
    if current.is_symlink():
        raise SystemExit(f"경로 구성요소 symlink를 허용하지 않습니다: {current}")
PY
}

absolute_git_dir() {
  local repository=$1
  git -C "$repository" rev-parse --absolute-git-dir
}

assert_exact_head() {
  local repository=$1
  local expected=$2
  local actual
  actual=$(git -C "$repository" rev-parse HEAD)
  [ "$actual" = "$expected" ] || \
    die "HEAD 불일치: 예상 $expected, 실제 $actual"
}

sha256_file() {
  local file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum 또는 shasum이 필요합니다"
  fi
}

verify_sha256_sums() {
  local directory=$1
  local sums_file="$directory/SHA256SUMS"
  local expected
  local relative_path
  local actual
  [ -f "$sums_file" ] || die "SHA256SUMS가 없습니다: $directory"

  while IFS='  ' read -r expected relative_path; do
    [ -n "$expected" ] || continue
    case "$relative_path" in
      /*|*/*|*..*) die "안전하지 않은 SHA256SUMS 경로: $relative_path" ;;
    esac
    [ -f "$directory/$relative_path" ] || die "릴리스 파일 누락: $relative_path"
    actual=$(sha256_file "$directory/$relative_path")
    [ "$actual" = "$expected" ] || die "SHA-256 불일치: $relative_path"
  done < "$sums_file"
}

assert_source_layout() {
  local plugin_path
  local adapter_path
  local source_symlink
  assert_compatibility_alignment
  plugin_path="$PERFETTO_PROJECT_ROOT/$(compat_value integration.source_plugin_path)"
  adapter_path="$PERFETTO_PROJECT_ROOT/$(compat_value integration.source_adapter_path)"
  [ -f "$plugin_path/index.ts" ] || die "플러그인 index.ts가 없습니다: $plugin_path"
  [ -f "$adapter_path/protocol.ts" ] || die "adapter protocol.ts가 없습니다: $adapter_path"
  [ -d "$adapter_path/v57" ] || die "v57 adapter가 없습니다: $adapter_path/v57"
  source_symlink=$(find "$plugin_path" "$adapter_path" -type l -print -quit)
  [ -z "$source_symlink" ] || die "plugin/adapter source에 symlink를 허용하지 않습니다: $source_symlink"
}

assert_perfetto_node() {
  local repository=$1
  [ -x "$repository/ui/node" ] || die "Perfetto ui/node wrapper가 없습니다"
  if ! "$repository/ui/node" --version >/dev/null 2>&1; then
    die "Perfetto hermetic Node.js가 없습니다. 네트워크 정책 검토 후 tools/install-build-deps --ui를 실행하십시오"
  fi
}
