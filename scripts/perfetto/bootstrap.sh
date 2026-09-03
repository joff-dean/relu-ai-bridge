#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법: scripts/perfetto/bootstrap.sh [PERFETTO_DIR]

공식 Perfetto v58.2를 별도 작업공간에 clone하고 정확한 commit을 checkout한다.
기본 경로는 프로젝트 바깥의 ../.relu-ai-bridge-work/perfetto-v58.2 이다.
public baseline bundle의 object closure를 위해 tag ancestry는 shallow로 자르지 않는다.
기존 저장소의 remote, HEAD 또는 변경 상태가 다르면 수정하지 않고 중단한다.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

require_command git
assert_python_310
assert_compatibility_alignment

upstream_url=$(compat_value public_baseline.repository)
upstream_tag=$(compat_value public_baseline.release)
upstream_tag_object=$(compat_value public_baseline.tag_object_sha)
upstream_commit=$(compat_value public_baseline.commit_sha)
default_workspace="$PERFETTO_PROJECT_ROOT/../.relu-ai-bridge-work/perfetto-v58.2"
target=${1:-$default_workspace}
assert_destination_outside_project_root "$target"

if [ -e "$target" ] || [ -L "$target" ]; then
  target=$(canonical_existing_dir "$target")
  assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$target"
  assert_git_worktree_root "$target"
  assert_git_metadata_outside_project_root "$target"
  origin_url=$(git -C "$target" remote get-url origin 2>/dev/null || true)
  [ "$origin_url" = "$upstream_url" ] || \
    die "기존 origin이 공식 Perfetto URL과 다릅니다: $origin_url"
  [ -z "$(git -C "$target" status --porcelain --untracked-files=all)" ] || \
    die "기존 Perfetto 작업공간에 변경 사항이 있습니다: $target"
  [ "$(git -C "$target" rev-parse --is-shallow-repository)" = false ] || \
    die "기존 Perfetto 작업공간이 shallow라서 완전한 baseline bundle을 만들 수 없습니다. 새 경로에 다시 bootstrap하십시오"
  [ "$(git -C "$target" config --bool --get remote.origin.promisor 2>/dev/null || true)" != true ] || \
    die "기존 Perfetto 작업공간이 partial/promisor clone입니다. 자립형 baseline을 위해 새 경로에 다시 bootstrap하십시오"
  assert_exact_head "$target" "$upstream_commit"
  resolved_tag=$(git -C "$target" rev-parse "refs/tags/$upstream_tag" 2>/dev/null || true)
  [ "$resolved_tag" = "$upstream_tag_object" ] || \
    die "tag object SHA가 일치하지 않습니다: $resolved_tag"
  peeled_tag=$(git -C "$target" rev-parse "refs/tags/$upstream_tag^{}" 2>/dev/null || true)
  [ "$peeled_tag" = "$upstream_commit" ] || \
    die "tag가 예상 commit을 가리키지 않습니다: $peeled_tag"
  info "이미 검증된 작업공간입니다: $target"
  exit 0
fi

parent_dir=$(dirname -- "$target")
mkdir -p -- "$parent_dir"
parent_dir=$(canonical_existing_dir "$parent_dir")
target="$parent_dir/$(basename -- "$target")"
case "$target/" in
  "$PERFETTO_PROJECT_ROOT/"|"$PERFETTO_PROJECT_ROOT/"*)
    die "Perfetto 작업공간은 RELU AI Bridge 프로젝트 밖에 두어야 합니다"
    ;;
esac
staging_dir=$(mktemp -d "$parent_dir/.perfetto-bootstrap.XXXXXX")
cleanup() {
  if [ -d "$staging_dir" ]; then
    rm -rf -- "$staging_dir"
  fi
}
trap cleanup EXIT INT TERM

info "공식 Perfetto $upstream_tag clone 중"
git clone --no-checkout --single-branch --branch "$upstream_tag" \
  "$upstream_url" "$staging_dir/repository"

resolved_tag=$(git -C "$staging_dir/repository" rev-parse "refs/tags/$upstream_tag")
[ "$resolved_tag" = "$upstream_tag_object" ] || \
  die "원격 tag object SHA 불일치: 예상 $upstream_tag_object, 실제 $resolved_tag"
peeled_tag=$(git -C "$staging_dir/repository" rev-parse "refs/tags/$upstream_tag^{}")
[ "$peeled_tag" = "$upstream_commit" ] || \
  die "원격 tag commit SHA 불일치: 예상 $upstream_commit, 실제 $peeled_tag"

git -C "$staging_dir/repository" checkout --detach "$upstream_commit"
assert_exact_head "$staging_dir/repository" "$upstream_commit"
[ "$(git -C "$staging_dir/repository" rev-parse --is-shallow-repository)" = false ] || \
  die "공식 Perfetto clone이 예상과 달리 shallow입니다"
[ "$(git -C "$staging_dir/repository" config --bool --get remote.origin.promisor 2>/dev/null || true)" != true ] || \
  die "공식 Perfetto clone이 예상과 달리 partial/promisor clone입니다"
[ -z "$(git -C "$staging_dir/repository" status --porcelain --untracked-files=all)" ] || \
  die "clone 직후 작업공간이 깨끗하지 않습니다"

assert_path_absent "$target"
mv -- "$staging_dir/repository" "$target"
info "완료: $target"
info "HEAD: $upstream_commit"
