#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
umask 077

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/import-release.sh [--require-signed-tag] \
    RELEASE_DIR LOCAL_BARE_MIRROR

원본 bundle은 mirror에 직접 fetch하지 않는다. 빈 임시 저장소에서 head/object 집합과
내용을 검역하고 exact tag만 다시 만든 bundle을 quarantine ref로 fetch한 다음,
annotated tag와 immutable release ref를 한 update-ref transaction으로 고정한다.
EOF
}

require_signed=0
case "${1:-}" in
  --require-signed-tag) require_signed=1; shift ;;
  -h|--help) usage; exit 0 ;;
esac
[ "$#" -eq 2 ] || { usage >&2; exit 2; }
require_command git
require_command python3
require_command cmp
[ ! -L "$1" ] || die "RELEASE_DIR symlink를 허용하지 않습니다"
release_dir=$(canonical_existing_dir "$1")
[ ! -L "$2" ] || die "LOCAL_BARE_MIRROR symlink를 허용하지 않습니다"
mirror_dir=$(canonical_existing_dir "$2")
assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$mirror_dir"
[ "$(git -C "$mirror_dir" rev-parse --is-bare-repository 2>/dev/null || true)" = true ] || \
  die "대상은 사내 로컬 bare mirror여야 합니다: $mirror_dir"
mirror_git_dir=$(git -C "$mirror_dir" rev-parse --absolute-git-dir)
mirror_git_dir=$(canonical_existing_dir "$mirror_git_dir")
[ "$mirror_dir" = "$mirror_git_dir" ] || \
  die "bare mirror 최상위 디렉터리를 정확히 지정해야 합니다: $mirror_git_dir"
[ ! -s "$mirror_dir/objects/info/alternates" ] && \
  [ ! -s "$mirror_dir/objects/info/http-alternates" ] || \
  die "immutable mirror는 alternate object store 없이 self-contained여야 합니다"

import_root=$(mktemp -d /tmp/relu-ai-bridge-import.XXXXXX)
safe_bundle="$import_root/exact-tag.bundle"
import_ref=
tag_object=
cleanup() {
  if [ -n "$import_ref" ] && [ -n "$tag_object" ] && \
     git -C "$mirror_dir" show-ref --verify --quiet "$import_ref"; then
    git -C "$mirror_dir" update-ref -d "$import_ref" "$tag_object" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$import_root"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

git -C "$mirror_dir" fsck --strict --no-reflogs --no-dangling --no-progress \
  >/dev/null 2>&1 || die "immutable mirror 기존 object/ref 무결성 검증 실패"
git -C "$mirror_dir" cat-file --batch-all-objects \
  --batch-check='%(objectname)' | LC_ALL=C sort -u > "$import_root/all-before.txt"
git -C "$mirror_dir" rev-list --objects --all | \
  awk '{print $1}' | LC_ALL=C sort -u > "$import_root/reachable-before.txt"
cmp -s "$import_root/all-before.txt" "$import_root/reachable-before.txt" || \
  die "immutable mirror에 기존 ref에서 도달할 수 없는 object가 있습니다"

if [ "$require_signed" -eq 1 ]; then
  "$SCRIPT_DIR/verify-release.sh" --require-signed-tag \
    --sanitized-bundle "$safe_bundle" "$release_dir"
else
  "$SCRIPT_DIR/verify-release.sh" --sanitized-bundle "$safe_bundle" "$release_dir"
fi

head_values=$(python3 - "$safe_bundle" <<'PY'
import re
import subprocess
import sys

heads = subprocess.run(
    ["git", "bundle", "list-heads", sys.argv[1]],
    check=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
).stdout
match = re.fullmatch(
    r"([0-9a-f]{40}) refs/tags/(relu-ai-bridge-v[0-9]+\.[0-9]+\.[0-9]+)\n?",
    heads,
)
if match is None:
    raise SystemExit("sanitized bundle exact tag head 형식 오류")
tag_object, tag = match.groups()
print(tag)
print(tag_object)
PY
) || die "sanitized bundle head 재검증 실패"
release_tag=$(printf '%s\n' "$head_values" | sed -n '1p')
tag_object=$(printf '%s\n' "$head_values" | sed -n '2p')
[ "$release_tag" = "$(relu_value release.tag_prefix)$(relu_value product.core_version)" ] || \
  die "sanitized bundle tag와 현재 RELU core contract가 다릅니다"
tag_ref="refs/tags/$release_tag"
release_ref="$(relu_value release.immutable_ref_namespace)$release_tag"

# mirror를 쓰기 전에 private inspection repo에서 sanitized tag의 peeled commit을
# 도출한다. 기존 immutable ref 충돌이면 mirror ODB에 dangling object조차 남기지 않는다.
inspect_repo="$import_root/inspection.git"
git init --bare --quiet --template= "$inspect_repo"
git -c transfer.fsckObjects=true -c fetch.fsckObjects=true -c gc.auto=0 \
  -c maintenance.auto=false -C "$inspect_repo" \
  fetch --quiet --no-tags "$safe_bundle" "$tag_ref:$tag_ref"
[ "$(git -C "$inspect_repo" cat-file -t "$tag_ref")" = tag ] || \
  die "sanitized bundle ref가 annotated tag object가 아닙니다"
[ "$(git -C "$inspect_repo" rev-parse "$tag_ref")" = "$tag_object" ] || \
  die "sanitized bundle raw tag object 불일치"
release_commit=$(git -C "$inspect_repo" rev-parse "$tag_ref^{}")
[ "$(git -C "$inspect_repo" cat-file -t "$release_commit")" = commit ] || \
  die "sanitized annotated tag가 commit을 가리키지 않습니다"

tag_exists=0
if git -C "$mirror_dir" show-ref --verify --quiet "$tag_ref"; then
  tag_exists=1
  [ -z "$(git -C "$mirror_dir" symbolic-ref -q "$tag_ref" 2>/dev/null || true)" ] || \
    die "immutable mirror의 기존 tag가 symbolic ref입니다"
  [ "$(git -C "$mirror_dir" cat-file -t "$tag_ref")" = tag ] || \
    die "immutable mirror의 기존 tag가 annotated tag가 아닙니다"
  [ "$(git -C "$mirror_dir" rev-parse "$tag_ref")" = "$tag_object" ] || \
    die "immutable mirror의 기존 raw tag object가 다릅니다"
  [ "$(git -C "$mirror_dir" rev-parse "$tag_ref^{}")" = "$release_commit" ] || \
    die "immutable mirror의 기존 tag peeled commit이 다릅니다"
fi

release_exists=0
if git -C "$mirror_dir" show-ref --verify --quiet "$release_ref"; then
  release_exists=1
  [ -z "$(git -C "$mirror_dir" symbolic-ref -q "$release_ref" 2>/dev/null || true)" ] || \
    die "immutable release ref가 symbolic ref입니다"
  [ "$(git -C "$mirror_dir" rev-parse "$release_ref")" = "$release_commit" ] || \
    die "immutable release ref 충돌: $release_ref"
fi

counter=0
while :; do
  import_ref="refs/imports/relu-ai-bridge/$release_tag.$$.${counter}"
  if ! git -C "$mirror_dir" show-ref --verify --quiet "$import_ref"; then break; fi
  counter=$((counter + 1))
done
git -c transfer.fsckObjects=true -c fetch.fsckObjects=true -c gc.auto=0 \
  -c maintenance.auto=false -C "$mirror_dir" \
  fetch --quiet --no-tags "$safe_bundle" "$tag_ref:$import_ref"
[ "$(git -C "$mirror_dir" cat-file -t "$import_ref")" = tag ] || \
  die "quarantine ref가 annotated tag object가 아닙니다"
[ "$(git -C "$mirror_dir" rev-parse "$import_ref")" = "$tag_object" ] || \
  die "quarantine raw tag object 불일치"
[ "$(git -C "$mirror_dir" rev-parse "$import_ref^{}")" = "$release_commit" ] || \
  die "quarantine peeled commit 불일치"

{
  printf '%s\n' start
  if [ "$tag_exists" -eq 1 ]; then
    printf 'verify %s %s\n' "$tag_ref" "$tag_object"
  else
    printf 'create %s %s\n' "$tag_ref" "$tag_object"
  fi
  if [ "$release_exists" -eq 1 ]; then
    printf 'verify %s %s\n' "$release_ref" "$release_commit"
  else
    printf 'create %s %s\n' "$release_ref" "$release_commit"
  fi
  printf 'delete %s %s\n' "$import_ref" "$tag_object"
  printf '%s\n' prepare commit
} | git -C "$mirror_dir" update-ref --stdin

import_ref=
[ "$(git -C "$mirror_dir" cat-file -t "$tag_ref")" = tag ] || \
  die "mirror 반입 후 annotated tag 검증 실패"
[ "$(git -C "$mirror_dir" rev-parse "$tag_ref")" = "$tag_object" ] || \
  die "mirror 반입 후 raw tag object 검증 실패"
[ "$(git -C "$mirror_dir" rev-parse "$tag_ref^{}")" = "$release_commit" ] || \
  die "mirror 반입 후 peeled commit 검증 실패"
[ "$(git -C "$mirror_dir" rev-parse "$release_ref")" = "$release_commit" ] || \
  die "mirror 반입 후 immutable release ref 검증 실패"
git -C "$mirror_dir" cat-file --batch-all-objects \
  --batch-check='%(objectname)' | LC_ALL=C sort -u > "$import_root/all-after.txt"
git -C "$mirror_dir" rev-list --objects --all | \
  awk '{print $1}' | LC_ALL=C sort -u > "$import_root/reachable-after.txt"
cmp -s "$import_root/all-after.txt" "$import_root/reachable-after.txt" || \
  die "mirror 반입 후 최종 ref에서 도달할 수 없는 object가 남았습니다"
info "immutable mirror 반입 완료: $tag_ref"
info "고정 release ref: $release_ref"
