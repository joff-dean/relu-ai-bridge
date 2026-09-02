#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
umask 077

case "${1:-}" in
  -h|--help)
    printf '%s\n' '사용법: scripts/perfetto/release-security-smoke-test.sh'
    exit 0
    ;;
esac
[ "$#" -eq 0 ] || die "인자를 받지 않습니다"
require_command git
require_command python3
require_command tar
assert_git_worktree_root "$PERFETTO_PROJECT_ROOT"
[ -z "$(git -C "$PERFETTO_PROJECT_ROOT" status --porcelain --untracked-files=all)" ] || \
  die "현재 commit을 시험하므로 먼저 clean checkout을 준비하십시오"

assert_tagged_version_branding_gate() {
  local repository=$1
  local tag=$2
  local tag_ref="refs/tags/$tag"
  [ -z "$(git -C "$repository" status --porcelain --untracked-files=all)" ] || \
    die "version/branding 검증 fixture가 clean하지 않습니다"
  [ "$(git -C "$repository" cat-file -t "$tag_ref")" = tag ] || \
    die "version/branding 검증 fixture는 annotated tag여야 합니다"
  [ "$(git -C "$repository" rev-parse HEAD)" = \
    "$(git -C "$repository" rev-parse "$tag_ref^{}")" ] || \
    die "version/branding 검증 fixture HEAD와 tag가 다릅니다"
  "$repository/scripts/perfetto/smoke-test.sh"
}

# 악성/구형 producer가 self-verification을 생략한 상황을 재현한다. 이 helper는
# production create-release 경로가 아니며, inbound verifier 회귀용 artifact만 만든다.
create_external_drift_release_fixture() {
  local repository=$1
  local tag=$2
  local output_dir=$3
  local base_manifest=$4
  local tag_ref="refs/tags/$tag"
  local bundle_name="$tag.bundle"
  local tag_object
  local release_commit
  local bundle_sha
  local bundle_size
  local core_blob
  local connector_blob
  local plugin_tree
  local adapter_tree

  assert_path_absent "$output_dir"
  mkdir -p -- "$output_dir"
  git -C "$repository" bundle create "$output_dir/$bundle_name" "$tag_ref"
  git -C "$repository" bundle verify "$output_dir/$bundle_name" >/dev/null
  tag_object=$(git -C "$repository" rev-parse "$tag_ref")
  release_commit=$(git -C "$repository" rev-parse "$tag_ref^{}")
  bundle_sha=$(sha256_file "$output_dir/$bundle_name")
  bundle_size=$(wc -c < "$output_dir/$bundle_name" | tr -d '[:space:]')
  core_blob=$(git -C "$repository" rev-parse "$tag:compat/relu-ai-bridge.json")
  connector_blob=$(git -C "$repository" rev-parse \
    "$tag:compat/connectors/perfetto-v57.2.json")
  plugin_tree=$(git -C "$repository" rev-parse \
    "$tag:$(compat_value integration.source_plugin_path)")
  adapter_tree=$(git -C "$repository" rev-parse \
    "$tag:$(compat_value integration.source_adapter_path)")

  git -c core.quotePath=true -C "$repository" \
    ls-tree -r "$tag" > "$output_dir/source-inventory.txt"
  git -c log.showSignature=false -C "$repository" log --topo-order \
    --format='%H%x09%P%x09%aI%x09%an <%ae>%x09%cn <%ce>%x09%s' "$tag" \
    > "$output_dir/history-inventory.txt"
  git -C "$repository" cat-file -p "$tag_ref" > "$output_dir/tag-metadata.txt"
  git -c core.quotePath=true -C "$repository" ls-tree -r "$tag" -- \
    package.json sdk/package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock \
    requirements.txt requirements.lock pyproject.toml uv.lock Cargo.toml Cargo.lock \
    sdk-dotnet/Relu.AI.Bridge.DesktopConnector.sln \
    sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj \
    sdk-dotnet/tests/Relu.AI.Bridge.DesktopConnector.Tests/Relu.AI.Bridge.DesktopConnector.Tests.csproj \
    examples/wpf-android-log-viewer/WpfAndroidLogViewer.Integration.csproj \
    skills/manifest.json \
    > "$output_dir/dependency-manifest.txt"

  python3 - "$base_manifest" "$output_dir/release-manifest.json" \
    "$tag_object" "$release_commit" "$bundle_sha" "$bundle_size" \
    "$core_blob" "$connector_blob" "$plugin_tree" "$adapter_tree" <<'PY'
import json
import pathlib
import sys

(
    source,
    output,
    tag_object,
    commit,
    bundle_sha,
    bundle_size,
    core_blob,
    connector_blob,
    plugin_tree,
    adapter_tree,
) = sys.argv[1:]
manifest = json.loads(pathlib.Path(source).read_text(encoding="utf-8"))
manifest["release"]["tag_object"] = tag_object
manifest["release"]["commit"] = commit
manifest["release"]["signed_tag_verified"] = False
manifest["artifact"]["sha256"] = bundle_sha
manifest["artifact"]["size_bytes"] = int(bundle_size)
manifest["compatibility"]["core_contract"]["blob"] = core_blob
manifest["compatibility"]["connectors"][0]["contract_blob"] = connector_blob
manifest["source_trees"]["connectors"]["perfetto"] = {
    "plugin": plugin_tree,
    "adapter": adapter_tree,
}
pathlib.Path(output).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

  for artifact in \
    "$bundle_name" release-manifest.json source-inventory.txt history-inventory.txt \
    tag-metadata.txt dependency-manifest.txt; do
    printf '%s  %s\n' "$(sha256_file "$output_dir/$artifact")" "$artifact"
  done > "$output_dir/SHA256SUMS"
}

test_root=$(mktemp -d /tmp/relu-release-security-smoke.XXXXXX)
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

fixture="$test_root/repository"
mkdir -p -- "$fixture"
git -C "$PERFETTO_PROJECT_ROOT" archive HEAD | tar -x -C "$fixture"
git -C "$fixture" init -q
git -C "$fixture" config user.name 'RELU Release Smoke'
git -C "$fixture" config user.email 'relu-release-smoke@example.invalid'
git -C "$fixture" add .
git -C "$fixture" commit -qm 'RELU release security smoke fixture'
base_branch=$(git -C "$fixture" symbolic-ref --short HEAD)
release_tag="$(relu_value release.tag_prefix)$(relu_value product.core_version)"
git -C "$fixture" tag -a "$release_tag" -m "RELU release smoke $release_tag"
assert_tagged_version_branding_gate "$fixture" "$release_tag" >/dev/null

release_dir="$test_root/release"
"$fixture/scripts/perfetto/create-release.sh" \
  --tag "$release_tag" --output "$release_dir" >/dev/null
"$fixture/scripts/perfetto/verify-release.sh" "$release_dir" >/dev/null
python3 - "$release_dir/release-manifest.json" <<'PY'
import json
import pathlib
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
connector = manifest["compatibility"]["connectors"][0]
if "company_integration" in connector or "company_integration_policy" in connector:
    raise SystemExit("외부 release manifest에 company integration metadata가 있습니다")
PY
git init --bare -q "$test_root/mirror.git"
"$fixture/scripts/perfetto/import-release.sh" \
  "$release_dir" "$test_root/mirror.git" >/dev/null
"$fixture/scripts/perfetto/import-release.sh" \
  "$release_dir" "$test_root/mirror.git" >/dev/null

# 릴리스 경계 검사가 root/SDK/extension/plugin/MCP/health/web/.NET version drift를 놓치지
# 않는지 각각 회귀 검증한다. Source fixture는 올바른 값을 주석에 남겨 단순 문자열
# 검색이 실제 선언 drift를 가리는 경우도 함께 재현한다.
for version_drift_case in root sdk extension plugin mcp health web-default dotnet-default dotnet-default-decoy dotnet-version-namespace dotnet-package-override dotnet-directory-override; do
  version_drift_repo="$test_root/version-drift-$version_drift_case"
  case "$version_drift_case" in
    root)
      version_drift_path=package.json
      version_drift_label='root package version'
      version_drift_kind=json
      ;;
    sdk)
      version_drift_path=sdk/package.json
      version_drift_label='SDK package version'
      version_drift_kind=json
      ;;
    extension)
      version_drift_path=extension/manifest.json
      version_drift_label='Chrome Companion version'
      version_drift_kind=json
      ;;
    plugin)
      version_drift_path=plugin/io.company.RELUPerfettoBridge/index.ts
      version_drift_label='Perfetto plugin version'
      version_drift_kind=source
      ;;
    mcp)
      version_drift_path=src/mcp.mjs
      version_drift_label='MCP serverInfo'
      version_drift_kind=source
      ;;
    health)
      version_drift_path=src/server.mjs
      version_drift_label='health identity'
      version_drift_kind=source
      ;;
    web-default)
      version_drift_path=sdk/relu-web-connector.js
      version_drift_label='web connector default version'
      version_drift_kind=source
      ;;
    dotnet-default)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluDesktopConnectorOptions.cs
      version_drift_label='.NET connector default version'
      version_drift_kind=source
      ;;
    dotnet-default-decoy)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluDesktopConnectorOptions.cs
      version_drift_label='.NET connector version declaration count'
      version_drift_kind=source
      ;;
    dotnet-version-namespace)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj
      version_drift_label='.NET SDK version'
      version_drift_kind=source
      ;;
    dotnet-package-override)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj
      version_drift_label='.NET SDK forbidden override: PackageVersion'
      version_drift_kind=source
      ;;
    dotnet-directory-override)
      version_drift_path=sdk-dotnet/Directory.Build.props
      version_drift_label='.NET SDK Directory.Build override'
      version_drift_kind=new-source
      ;;
  esac
  git clone --quiet --no-hardlinks "$fixture" "$version_drift_repo"
  git -C "$version_drift_repo" config user.name 'RELU Release Smoke'
  git -C "$version_drift_repo" config user.email 'relu-release-smoke@example.invalid'
  python3 - "$version_drift_repo/$version_drift_path" \
    "$version_drift_case" "$(relu_value product.core_version)" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
case = sys.argv[2]
version = sys.argv[3]
if case == "dotnet-directory-override":
    path.write_text(
        "<Project><PropertyGroup><PackageVersion>9.9.9</PackageVersion>"
        "</PropertyGroup></Project>\n",
        encoding="utf-8",
    )
    raise SystemExit(0)
if case in {"root", "sdk", "extension"}:
    value = json.loads(path.read_text(encoding="utf-8"))
    value["version"] = "9.9.9"
    updated = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
else:
    source = path.read_text(encoding="utf-8")
    replacements = {
        "plugin": (
            f"const PLUGIN_VERSION = '{version}';",
            f"const PLUGIN_VERSION = '9.9.9';\n// const PLUGIN_VERSION = '{version}';",
        ),
        "mcp": (
            f"serverInfo: {{ name: 'relu-ai-bridge', version: '{version}' }},",
            "serverInfo: { name: 'relu-ai-bridge', version: '9.9.9' },\n"
            f"        // serverInfo: {{ name: 'relu-ai-bridge', version: '{version}' }},",
        ),
        "health": (
            f"        version: '{version}',",
            "        version: '9.9.9',\n"
            "        /*\n"
            "        name: 'relu-ai-bridge',\n"
            f"        version: '{version}',\n"
            "        */",
        ),
        "web-default": (
            f"    this.connectorVersion = String(options.connectorVersion ?? '{version}');",
            "    this.connectorVersion = String(options.connectorVersion ?? '9.9.9');\n"
            f"    // this.connectorVersion = String(options.connectorVersion ?? '{version}');",
        ),
        "dotnet-default": (
            f'    public string ConnectorVersion {{ get; init; }} = "{version}";',
            '    public string ConnectorVersion { get; init; } = "9.9.9";\n'
            "    /*\n"
            f'    public string ConnectorVersion {{ get; init; }} = "{version}";\n'
            "    */",
        ),
        "dotnet-default-decoy": (
            f'    public string ConnectorVersion {{ get; init; }} = "{version}";',
            '    public string ConnectorVersion { get; init; } = "9.9.9";\n\n'
            "    private sealed class VersionGateDecoy\n"
            "    {\n"
            f'        public string ConnectorVersion {{ get; init; }} = "{version}";\n'
            "    }",
        ),
        "dotnet-package-override": (
            f"    <Version>{version}</Version>",
            f"    <Version>{version}</Version>\n"
            "    <PackageVersion>9.9.9</PackageVersion>",
        ),
        "dotnet-version-namespace": (
            f"    <Version>{version}</Version>",
            f'    <Version xmlns="urn:relu-version-decoy">{version}</Version>',
        ),
    }
    before, after = replacements[case]
    if source.count(before) != 1:
        raise SystemExit(f"source drift fixture target count mismatch: {case}")
    updated = source.replace(before, after)
path.write_text(updated, encoding="utf-8")
PY
  git -C "$version_drift_repo" add "$version_drift_path"
  git -C "$version_drift_repo" commit -qm "$version_drift_case version drift regression fixture"
  git -C "$version_drift_repo" tag -f -a "$release_tag" \
    -m "RELU $version_drift_case drift regression $release_tag" >/dev/null
  set +e
  version_drift_output=$(
    export PYTHONOPTIMIZE=1
    assert_tagged_version_branding_gate \
      "$version_drift_repo" "$release_tag" 2>&1
  )
  version_drift_status=$?
  set -e
  [ "$version_drift_status" -ne 0 ] || \
    die "$version_drift_case version drift가 릴리스 경계를 통과했습니다"
  printf '%s\n' "$version_drift_output" | \
    grep -Fq "version/branding contract 불일치: $version_drift_label"

  # Bundle 내부 도구는 실행하지 않고, 별도 trusted fixture verifier와 importer가
  # tagged blob drift를 독립적으로 거부해야 한다.
  version_drift_release="$test_root/version-drift-release-$version_drift_case"
  create_external_drift_release_fixture \
    "$version_drift_repo" "$release_tag" "$version_drift_release" \
    "$release_dir/release-manifest.json"
  set +e
  inbound_drift_output=$(
    "$fixture/scripts/perfetto/verify-release.sh" "$version_drift_release" 2>&1
  )
  inbound_drift_status=$?
  set -e
  [ "$inbound_drift_status" -ne 0 ] || \
    die "inbound $version_drift_case version drift bundle을 허용했습니다"
  printf '%s\n' "$inbound_drift_output" | \
    grep -Fq "inbound version/branding contract 불일치: $version_drift_label"

  version_drift_mirror="$test_root/version-drift-mirror-$version_drift_case.git"
  git init --bare -q "$version_drift_mirror"
  set +e
  inbound_import_output=$(
    "$fixture/scripts/perfetto/import-release.sh" \
      "$version_drift_release" "$version_drift_mirror" 2>&1
  )
  inbound_import_status=$?
  set -e
  [ "$inbound_import_status" -ne 0 ] || \
    die "import가 $version_drift_case version drift bundle을 허용했습니다"
  printf '%s\n' "$inbound_import_output" | \
    grep -Fq "inbound version/branding contract 불일치: $version_drift_label"
  [ -z "$(git -C "$version_drift_mirror" for-each-ref --format='%(refname)')" ] || \
    die "거부된 drift import가 mirror ref를 남겼습니다"
  [ -z "$(git -C "$version_drift_mirror" cat-file --batch-all-objects \
    --batch-check='%(objectname)')" ] || \
    die "거부된 drift import가 mirror object를 남겼습니다"
done

# bundle header는 정상 tag 하나만 광고하지만 pack에는 secret branch object도 넣는다.
# 단순 list-heads 검증을 우회하고 전체 ODB 검사가 필요한 회귀 fixture다.
git -C "$fixture" switch -qc secret-extra
printf '%s\n' 'INTERNAL-ONLY-UNREACHABLE-OBJECT' > "$fixture/hidden-object.bin"
git -C "$fixture" add hidden-object.bin
git -C "$fixture" commit -qm 'hidden object regression fixture'
secret_commit=$(git -C "$fixture" rev-parse HEAD)
secret_blob=$(git -C "$fixture" rev-parse HEAD:hidden-object.bin)
git -C "$fixture" switch -q "$base_branch"
tag_object=$(git -C "$fixture" rev-parse "refs/tags/$release_tag")
printf '%s\n%s\n' "$tag_object" "$secret_commit" | \
  git -C "$fixture" pack-objects --stdout --revs > "$test_root/hidden-extra.pack"

malicious_dir="$test_root/hidden-object-release"
cp -R -- "$release_dir" "$malicious_dir"
python3 - "$malicious_dir/$release_tag.bundle" "$test_root/hidden-extra.pack" \
  "$tag_object" "$release_tag" "$malicious_dir/release-manifest.json" <<'PY'
import hashlib
import json
import pathlib
import sys

bundle = pathlib.Path(sys.argv[1])
pack = pathlib.Path(sys.argv[2])
tag_object = sys.argv[3]
tag = sys.argv[4]
manifest_path = pathlib.Path(sys.argv[5])
header = f"# v2 git bundle\n{tag_object} refs/tags/{tag}\n\n".encode("ascii")
bundle.write_bytes(header + pack.read_bytes())
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["artifact"]["sha256"] = hashlib.sha256(bundle.read_bytes()).hexdigest()
manifest["artifact"]["size_bytes"] = bundle.stat().st_size
manifest_path.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

for artifact in \
  "$release_tag.bundle" release-manifest.json source-inventory.txt \
  history-inventory.txt tag-metadata.txt dependency-manifest.txt; do
  printf '%s  %s\n' "$(sha256_file "$malicious_dir/$artifact")" "$artifact"
done > "$malicious_dir/SHA256SUMS"

[ "$(git bundle list-heads "$malicious_dir/$release_tag.bundle")" = \
  "$tag_object refs/tags/$release_tag" ] || die "회귀 fixture head 생성 실패"
set +e
malicious_output=$("$fixture/scripts/perfetto/verify-release.sh" "$malicious_dir" 2>&1)
malicious_status=$?
set -e
[ "$malicious_status" -ne 0 ] || die "hidden extra object bundle을 허용했습니다"
printf '%s\n' "$malicious_output" | \
  grep -Fq 'exact release tag에서 도달할 수 없는 extra object'

git init --bare -q "$test_root/reject-mirror.git"
set +e
"$fixture/scripts/perfetto/import-release.sh" \
  "$malicious_dir" "$test_root/reject-mirror.git" >/dev/null 2>&1
import_status=$?
set -e
[ "$import_status" -ne 0 ] || die "hidden extra object release를 mirror에 반입했습니다"
if git -C "$test_root/reject-mirror.git" cat-file -e "$secret_blob" 2>/dev/null; then
  die "거부된 secret blob이 mirror ODB에 유입되었습니다"
fi

# 같은 commit을 가리키더라도 raw annotated tag object가 다르면 immutable 충돌이다.
git -C "$fixture" tag -a alternate-tag-object -m 'different tag object' "$base_branch"
alternate_tag=$(git -C "$fixture" rev-parse refs/tags/alternate-tag-object)
git init --bare -q "$test_root/raw-tag-conflict.git"
git -C "$test_root/raw-tag-conflict.git" fetch -q "$fixture" \
  "refs/tags/alternate-tag-object:refs/tags/$release_tag"
set +e
"$fixture/scripts/perfetto/import-release.sh" \
  "$release_dir" "$test_root/raw-tag-conflict.git" >/dev/null 2>&1
raw_status=$?
set -e
[ "$raw_status" -ne 0 ] || die "다른 raw tag object를 동일 release로 허용했습니다"
[ "$(git -C "$test_root/raw-tag-conflict.git" rev-parse "refs/tags/$release_tag")" = \
  "$alternate_tag" ] || die "충돌 mirror의 기존 tag를 변경했습니다"

# NUL을 포함한 binary blob도 text 전용 grep처럼 건너뛰지 않아야 한다.
binary_repo="$test_root/binary-secret.git"
git -C "$test_root" init -q "$binary_repo"
git -C "$binary_repo" config user.name 'RELU Binary Scan'
git -C "$binary_repo" config user.email 'relu-binary-scan@example.invalid'
python3 - "$binary_repo/payload.bin" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(
    b"\0binary-prefix " + b"gh" + b"p_" + (b"A" * 32) + b" suffix\0"
)
PY
git -C "$binary_repo" add payload.bin
git -C "$binary_repo" commit -qm 'binary scanner regression fixture'
git -C "$binary_repo" tag -a binary-scan -m 'binary scan fixture'
set +e
binary_output=$(python3 "$fixture/scripts/perfetto/release-security-scan.py" \
  --repository "$binary_repo" --ref refs/tags/binary-scan 2>&1)
binary_status=$?
set -e
[ "$binary_status" -ne 0 ] || die "binary blob credential 형태를 놓쳤습니다"
printf '%s\n' "$binary_output" | grep -Fq 'credential 형태가 blob에 있습니다'

# private-key/token 변형을 source에 완성된 credential 형태로 저장하지 않고
# runtime에 조합해 scanner의 실제 Git-object 경계를 회귀 검증한다.
for credential_case in dsa encrypted pgp github-pat; do
  credential_repo="$test_root/credential-$credential_case.git"
  git -C "$test_root" init -q "$credential_repo"
  git -C "$credential_repo" config user.name 'RELU Credential Scan'
  git -C "$credential_repo" config user.email 'relu-credential-scan@example.invalid'
  python3 - "$credential_repo/payload.bin" "$credential_case" <<'PY'
import pathlib
import sys

pieces = {
    "dsa": (b"-----BEGIN DSA PRIVATE", b" KEY-----"),
    "encrypted": (b"-----BEGIN ENCRYPTED PRIVATE", b" KEY-----"),
    "pgp": (b"-----BEGIN PGP PRIVATE KEY", b" BLOCK-----"),
    "github-pat": (b"github", b"_pat_" + (b"A" * 32)),
}
pathlib.Path(sys.argv[1]).write_bytes(b"\0" + b"".join(pieces[sys.argv[2]]) + b"\0")
PY
  git -C "$credential_repo" add payload.bin
  git -C "$credential_repo" commit -qm 'credential scanner regression fixture'
  git -C "$credential_repo" tag -a credential-scan -m 'credential scan fixture'
  set +e
  credential_output=$(python3 "$fixture/scripts/perfetto/release-security-scan.py" \
    --repository "$credential_repo" --ref refs/tags/credential-scan 2>&1)
  credential_status=$?
  set -e
  [ "$credential_status" -ne 0 ] || \
    die "credential scanner가 변형을 놓쳤습니다: $credential_case"
  printf '%s\n' "$credential_output" | grep -Fq 'credential 형태가 blob에 있습니다'
done

# 외부 RELU 저장소를 common-dir로 쓰는 linked worktree는 회사 코드 backup을
# 외부 .git 안에 만들 수 있으므로 metadata 경계에서 거부해야 한다.
linked_worktree="$test_root/linked-company-target"
git -C "$fixture" worktree add --detach -q "$linked_worktree" HEAD
set +e
metadata_output=$(bash -c '. "$1"; assert_git_metadata_outside_project_root "$2"' \
  relu-smoke "$fixture/scripts/perfetto/common.sh" "$linked_worktree" 2>&1)
metadata_status=$?
set -e
[ "$metadata_status" -ne 0 ] || die "외부 RELU git-dir를 쓰는 linked worktree를 허용했습니다"
printf '%s\n' "$metadata_output" | grep -Fq 'source와 target tree가 같거나 중첩됩니다'

# 활성화 patch는 default_plugins.ts 한 줄 추가만 허용해야 rollback 범위와 같다.
unauthorized_patch="$test_root/unauthorized-enable.patch"
cp -- "$fixture/integration/patches/perfetto-v57.2-enable-default-plugin.patch" \
  "$unauthorized_patch"
cat >> "$unauthorized_patch" <<'PATCH'
diff --git a/UNAUTHORIZED b/UNAUTHORIZED
new file mode 100644
index 0000000..cc20273
--- /dev/null
+++ b/UNAUTHORIZED
@@ -0,0 +1 @@
+unauthorized
PATCH
set +e
patch_output=$(bash -c '. "$1"; assert_single_file_patch "$2" "$3"' \
  relu-smoke "$fixture/scripts/perfetto/common.sh" "$unauthorized_patch" \
  ui/src/core/embedder/default_plugins.ts 2>&1)
patch_status=$?
set -e
[ "$patch_status" -ne 0 ] || die "허용 범위 밖 hunk가 있는 enable patch를 허용했습니다"
printf '%s\n' "$patch_output" | grep -Fq '한 줄 추가만 허용합니다'

info "release security smoke test 통과"
info "정상 version/branding/create/verify/import와 producer/inbound/import drift·hidden object·credential·linked worktree·추가 patch hunk 거부를 확인했습니다"
