#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

case "${1:-}" in -h|--help)
  printf '%s\n' '사용법: scripts/perfetto/export-upstream-baseline.sh PERFETTO_DIR OUTPUT_DIR'
  exit 0
;; esac
[ "$#" -eq 2 ] || \
  die "사용법: scripts/perfetto/export-upstream-baseline.sh PERFETTO_DIR OUTPUT_DIR"
require_command git
require_command cmp
assert_compatibility_alignment
perfetto_dir=$(canonical_existing_dir "$1")
output_dir=$2
assert_destination_outside_project_root "$output_dir"
assert_path_absent "$output_dir"
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$perfetto_dir"
assert_git_worktree_root "$perfetto_dir"
assert_git_metadata_outside_project_root "$perfetto_dir"
origin_url=$(git -C "$perfetto_dir" remote get-url origin 2>/dev/null || true)
[ "$origin_url" = "$(compat_value public_baseline.repository)" ] || \
  die "공식 Perfetto origin이 아닌 저장소에서는 baseline을 export하지 않습니다"
[ "$(git -C "$perfetto_dir" rev-parse --is-shallow-repository)" = false ] || \
  die "완전한 public baseline bundle에는 non-shallow Perfetto checkout이 필요합니다"
[ "$(git -C "$perfetto_dir" config --bool --get remote.origin.promisor 2>/dev/null || true)" != true ] || \
  die "자립형 public baseline bundle에는 partial/promisor가 아닌 완전한 checkout이 필요합니다"
upstream_tag=$(compat_value public_baseline.release)
tag_object=$(compat_value public_baseline.tag_object_sha)
upstream_commit=$(compat_value public_baseline.commit_sha)
[ "$(git -C "$perfetto_dir" rev-parse "refs/tags/$upstream_tag")" = "$tag_object" ] || \
  die "공식 tag object SHA가 다릅니다"
[ "$(git -C "$perfetto_dir" rev-parse "refs/tags/$upstream_tag^{}")" = "$upstream_commit" ] || \
  die "공식 tag commit SHA가 다릅니다"

output_parent=$(dirname -- "$output_dir")
mkdir -p -- "$output_parent"
output_parent=$(canonical_existing_dir "$output_parent")
output_dir="$output_parent/$(basename -- "$output_dir")"
stage_dir=$(mktemp -d "$output_parent/.perfetto-upstream-release.XXXXXX")
verify_root=
cleanup() {
  if [ -d "$stage_dir" ]; then rm -rf -- "$stage_dir"; fi
  if [ -n "$verify_root" ] && [ -d "$verify_root" ]; then rm -rf -- "$verify_root"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
verify_root=$(mktemp -d /tmp/perfetto-upstream-bundle-verify.XXXXXX)

bundle_name="perfetto-$upstream_tag-upstream.bundle"
git -C "$perfetto_dir" bundle create "$stage_dir/$bundle_name" "refs/tags/$upstream_tag"
git -C "$perfetto_dir" bundle verify "$stage_dir/$bundle_name" >/dev/null
[ "$(git bundle list-heads "$stage_dir/$bundle_name")" = \
  "$tag_object refs/tags/$upstream_tag" ] || die "공식 기준선 bundle head 집합 오류"

# shallow/promisor 누락으로 겉보기 bundle만 만들어지는 것을 막기 위해 완전히 빈
# 저장소가 독립 fetch할 수 있는지 확인한다.
git init --bare --quiet --template= "$verify_root/repository.git"
git -c transfer.fsckObjects=true -c fetch.fsckObjects=true -c gc.auto=0 \
  -c maintenance.auto=false -C "$verify_root/repository.git" \
  fetch --quiet --no-tags "$stage_dir/$bundle_name" \
  "refs/tags/$upstream_tag:refs/tags/$upstream_tag"
[ "$(git -C "$verify_root/repository.git" rev-parse "refs/tags/$upstream_tag")" = \
  "$tag_object" ] || die "빈 저장소 baseline raw tag 검증 실패"
[ "$(git -C "$verify_root/repository.git" rev-parse "refs/tags/$upstream_tag^{}")" = \
  "$upstream_commit" ] || die "빈 저장소 baseline commit 검증 실패"
git -C "$verify_root/repository.git" cat-file --batch-all-objects \
  --batch-check='%(objectname)' | LC_ALL=C sort -u > "$verify_root/all-objects.txt"
git -C "$verify_root/repository.git" rev-list --objects "refs/tags/$upstream_tag" | \
  awk '{print $1}' | LC_ALL=C sort -u > "$verify_root/reachable-objects.txt"
cmp -s "$verify_root/all-objects.txt" "$verify_root/reachable-objects.txt" || \
  die "공식 baseline bundle에 tag reachability 밖 object가 있습니다"
printf '%s  %s\n' "$(sha256_file "$stage_dir/$bundle_name")" "$bundle_name" \
  > "$stage_dir/SHA256SUMS"
assert_path_absent "$output_dir"
mv -- "$stage_dir" "$output_dir"
info "공식 기준선 bundle 생성 완료: $output_dir"
