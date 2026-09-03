#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
umask 077

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/create-release.sh --tag TAG --output OUTPUT_DIR [--require-signed-tag]

clean checkout의 RELU AI Bridge core annotated tag로 다음 반입 묶음을 원자적으로
생성한다.
  TAG.bundle, release-manifest.json, source-inventory.txt,
  history-inventory.txt, tag-metadata.txt, dependency-manifest.txt, SHA256SUMS

TAG는 compat/relu-ai-bridge.json의 tag_prefix + core_version과 정확히 같아야 한다.
OUTPUT_DIR은 존재하지 않아야 한다. --require-signed-tag를 사용하면 현재
Git trust store 기준으로 git verify-tag까지 통과해야 한다.
EOF
}

release_tag=
output_dir=
require_signed=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) [ "$#" -ge 2 ] || die "--tag 값이 필요합니다"; release_tag=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || die "--output 값이 필요합니다"; output_dir=$2; shift 2 ;;
    --require-signed-tag) require_signed=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

[ -n "$release_tag" ] && [ -n "$output_dir" ] || { usage >&2; exit 2; }
case "$release_tag" in *[!A-Za-z0-9._-]*) die "안전하지 않은 tag 이름입니다" ;; esac
core_version=$(relu_value product.core_version)
tag_prefix=$(relu_value release.tag_prefix)
assert_compatibility_alignment
expected_tag="$tag_prefix$core_version"
[ "$release_tag" = "$expected_tag" ] || \
  die "tag는 core compatibility contract와 정확히 같아야 합니다: $expected_tag"
package_identity=$(python3 - "$PERFETTO_PROJECT_ROOT/package.json" <<'PY'
import json
import pathlib
import sys

package = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(package.get("name", ""))
print(package.get("version", ""))
PY
)
[ "$(printf '%s\n' "$package_identity" | sed -n '1p')" = relu-ai-bridge ] || \
  die "package name은 relu-ai-bridge여야 합니다"
[ "$(printf '%s\n' "$package_identity" | sed -n '2p')" = "$core_version" ] || \
  die "package version과 RELU core version이 다릅니다"
assert_destination_outside_project_root "$output_dir"
assert_path_absent "$output_dir"

require_command git
require_command python3
assert_git_worktree_root "$PERFETTO_PROJECT_ROOT"
[ -z "$(git -C "$PERFETTO_PROJECT_ROOT" status --porcelain --untracked-files=all)" ] || \
  die "릴리스 생성 전 프로젝트 checkout이 clean해야 합니다"
git -C "$PERFETTO_PROJECT_ROOT" show-ref --verify --quiet "refs/tags/$release_tag" || \
  die "tag가 없습니다: $release_tag"
[ "$(git -C "$PERFETTO_PROJECT_ROOT" cat-file -t "refs/tags/$release_tag")" = tag ] || \
  die "annotated tag만 릴리스할 수 있습니다"

tag_object=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse "refs/tags/$release_tag")
release_commit=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse "refs/tags/$release_tag^{}")
head_commit=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse HEAD)
[ "$release_commit" = "$head_commit" ] || \
  die "현재 HEAD가 릴리스 tag commit과 다릅니다: $release_commit"
if [ "$require_signed" -eq 1 ]; then
  git -C "$PERFETTO_PROJECT_ROOT" verify-tag "$release_tag"
fi

# text/binary blob, raw commit/tag metadata, 모든 과거 tree 경로와 symlink를 같은
# fail-closed scanner로 검역한다. scanner 오류도 곧 릴리스 실패다.
python3 "$SCRIPT_DIR/release-security-scan.py" \
  --repository "$PERFETTO_PROJECT_ROOT" --ref "refs/tags/$release_tag"

output_parent=$(dirname -- "$output_dir")
mkdir -p -- "$output_parent"
output_parent=$(canonical_existing_dir "$output_parent")
output_dir="$output_parent/$(basename -- "$output_dir")"
stage_dir=$(mktemp -d "$output_parent/.relu-ai-bridge-release.XXXXXX")
cleanup() {
  if [ -d "$stage_dir" ]; then rm -rf -- "$stage_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

bundle_name="$release_tag.bundle"
tag_ref="refs/tags/$release_tag"
git -C "$PERFETTO_PROJECT_ROOT" bundle create "$stage_dir/$bundle_name" "$tag_ref"
git -C "$PERFETTO_PROJECT_ROOT" bundle verify "$stage_dir/$bundle_name" >/dev/null
bundle_heads=$(git bundle list-heads "$stage_dir/$bundle_name")
[ "$bundle_heads" = "$tag_object $tag_ref" ] || \
  die "생성된 bundle이 exact release tag 이외 ref를 광고합니다"

git -c core.quotePath=true -C "$PERFETTO_PROJECT_ROOT" \
  ls-tree -r "$release_tag" > "$stage_dir/source-inventory.txt"
git -c log.showSignature=false -C "$PERFETTO_PROJECT_ROOT" log --topo-order \
  --format='%H%x09%P%x09%aI%x09%an <%ae>%x09%cn <%ce>%x09%s' "$release_tag" \
  > "$stage_dir/history-inventory.txt"
git -C "$PERFETTO_PROJECT_ROOT" cat-file -p "$tag_ref" \
  > "$stage_dir/tag-metadata.txt"
git -c core.quotePath=true -C "$PERFETTO_PROJECT_ROOT" ls-tree -r "$release_tag" -- \
  package.json sdk/package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock \
  requirements.txt requirements.lock pyproject.toml uv.lock Cargo.toml Cargo.lock \
  sdk-dotnet/Relu.AI.Bridge.DesktopConnector.sln \
  sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj \
  sdk-dotnet/tests/Relu.AI.Bridge.DesktopConnector.Tests/Relu.AI.Bridge.DesktopConnector.Tests.csproj \
  examples/wpf-android-log-viewer/WpfAndroidLogViewer.Integration.csproj \
  skills/manifest.json \
  > "$stage_dir/dependency-manifest.txt"

bundle_sha=$(sha256_file "$stage_dir/$bundle_name")
bundle_size=$(wc -c < "$stage_dir/$bundle_name" | tr -d '[:space:]')
core_contract_path=compat/relu-ai-bridge.json
connector_contract_path="compat/$(relu_value connectors.0.manifest)"
core_contract_blob=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse \
  "$release_tag:$core_contract_path")
connector_contract_blob=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse \
  "$release_tag:$connector_contract_path")
tagged_tree_oid() {
  local relative=$1
  local object_id
  object_id=$(git -C "$PERFETTO_PROJECT_ROOT" rev-parse \
    "$release_tag:$relative" 2>/dev/null) || \
    die "tagged 필수 source tree 누락: $relative"
  [ "$(git -C "$PERFETTO_PROJECT_ROOT" cat-file -t "$object_id" 2>/dev/null || true)" = tree ] || \
    die "tagged 필수 source path가 tree가 아닙니다: $relative"
  printf '%s\n' "$object_id"
}
plugin_tree=$(tagged_tree_oid "$(compat_value integration.source_plugin_path)")
adapter_tree=$(tagged_tree_oid "$(compat_value integration.source_adapter_path)")
core_bin_tree=$(tagged_tree_oid bin)
core_src_tree=$(tagged_tree_oid src)
core_web_tree=$(tagged_tree_oid web)
embedded_sdk_tree=$(tagged_tree_oid sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector)
created_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

python3 - "$stage_dir/release-manifest.json" "$RELU_COMPAT_FILE" "$PERFETTO_COMPAT_FILE" \
  "$release_tag" "$tag_object" "$release_commit" "$created_utc" \
  "$bundle_name" "$bundle_sha" "$bundle_size" "$core_contract_path" "$core_contract_blob" \
  "$connector_contract_path" "$connector_contract_blob" "$plugin_tree" "$adapter_tree" \
  "$core_bin_tree" "$core_src_tree" "$core_web_tree" "$embedded_sdk_tree" <<'PY'
import json
import pathlib
import sys

(
    output,
    relu_path,
    connector_path,
    tag,
    tag_object,
    commit,
    created_utc,
    bundle,
    bundle_sha,
    bundle_size,
    core_contract_path,
    core_contract_blob,
    connector_contract_path,
    connector_contract_blob,
    plugin_tree,
    adapter_tree,
    core_bin_tree,
    core_src_tree,
    core_web_tree,
    embedded_sdk_tree,
) = sys.argv[1:]
relu = json.loads(pathlib.Path(relu_path).read_text(encoding="utf-8"))
connector = json.loads(pathlib.Path(connector_path).read_text(encoding="utf-8"))
manifest = {
    "schema_version": 2,
    "project": "relu-ai-bridge",
    "product": {
        "name": relu["product"]["name"],
        "core_version": relu["product"]["core_version"],
    },
    "release": {
        "tag": tag,
        "tag_object": tag_object,
        "commit": commit,
        "created_utc": created_utc,
        "annotated_tag": True,
    },
    "artifact": {
        "git_bundle": bundle,
        "sha256": bundle_sha,
        "size_bytes": int(bundle_size),
        "advertised_heads": [f"refs/tags/{tag}"],
        "object_scope": "exact-tag-reachable-only",
    },
    "compatibility": {
        "core_contract": {
            "path": core_contract_path,
            "blob": core_contract_blob,
        },
        "connectors": [
            {
                "number": connector["connector"]["number"],
                "id": connector["connector"]["id"],
                "name": connector["connector"]["name"],
                "version": connector["connector"]["version"],
                "adapter_contract": connector["connector"]["adapter_contract"],
                "manifest_path": connector_contract_path,
                "contract_blob": connector_contract_blob,
                "compatible_relu_core_versions": connector["connector"][
                    "compatible_relu_core_versions"
                ],
                "public_baseline": connector["public_baseline"],
            }
        ],
    },
    "source_trees": {
        "core": {
            "bin": core_bin_tree,
            "src": core_src_tree,
            "web": core_web_tree,
        },
        "desktop": {"embedded_sdk": embedded_sdk_tree},
        "connectors": {
            "perfetto": {"plugin": plugin_tree, "adapter": adapter_tree}
        }
    },
    "security": {
        "all_reachable_blob_scan": "passed",
        "raw_commit_and_tag_metadata_scan": "passed",
        "reachable_history_path_scan": "passed",
        "reachable_history_symlink_scan": "passed",
        "exact_bundle_head_check": "passed",
        "human_outbound_review_required": True,
    },
}
pathlib.Path(output).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

for artifact in \
  "$bundle_name" release-manifest.json source-inventory.txt history-inventory.txt \
  tag-metadata.txt dependency-manifest.txt; do
  printf '%s  %s\n' "$(sha256_file "$stage_dir/$artifact")" "$artifact"
done > "$stage_dir/SHA256SUMS"

if [ "$require_signed" -eq 1 ]; then
  "$SCRIPT_DIR/verify-release.sh" --require-signed-tag "$stage_dir" >/dev/null
else
  "$SCRIPT_DIR/verify-release.sh" "$stage_dir" >/dev/null
fi
assert_path_absent "$output_dir"
mv -- "$stage_dir" "$output_dir"
info "RELU AI Bridge 릴리스 묶음 생성 완료: $output_dir"
info "반입 전 별도 담당자가 inventory, tag metadata와 staged bundle을 검토해야 합니다"
