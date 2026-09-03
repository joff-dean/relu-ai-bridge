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
# 이 smoke는 build-test의 installer/build 사후변조 회귀도 실제 실행한다.
# 긴 release fixture를 만들기 전에 v58.2 build host 조건을 먼저 fail-fast 검사한다.
assert_perfetto_build_host
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
  local core_bin_tree
  local core_src_tree
  local core_web_tree
  local plugin_tree
  local adapter_tree
  local embedded_sdk_tree

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
    "$tag:compat/connectors/perfetto-v58.2.json")
  core_bin_tree=$(git -C "$repository" rev-parse "$tag:bin")
  core_src_tree=$(git -C "$repository" rev-parse "$tag:src")
  core_web_tree=$(git -C "$repository" rev-parse "$tag:web")
  plugin_tree=$(git -C "$repository" rev-parse \
    "$tag:$(compat_value integration.source_plugin_path)")
  adapter_tree=$(git -C "$repository" rev-parse \
    "$tag:$(compat_value integration.source_adapter_path)")
  embedded_sdk_tree=$(git -C "$repository" rev-parse \
    "$tag:sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector")

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
    "$core_blob" "$connector_blob" "$core_bin_tree" "$core_src_tree" \
    "$core_web_tree" "$plugin_tree" "$adapter_tree" \
    "$embedded_sdk_tree" <<'PY'
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
    core_bin_tree,
    core_src_tree,
    core_web_tree,
    plugin_tree,
    adapter_tree,
    embedded_sdk_tree,
) = sys.argv[1:]
manifest = json.loads(pathlib.Path(source).read_text(encoding="utf-8"))
manifest["release"]["tag_object"] = tag_object
manifest["release"]["commit"] = commit
manifest["artifact"]["sha256"] = bundle_sha
manifest["artifact"]["size_bytes"] = int(bundle_size)
manifest["compatibility"]["core_contract"]["blob"] = core_blob
manifest["compatibility"]["connectors"][0]["contract_blob"] = connector_blob
manifest["source_trees"]["core"] = {
    "bin": core_bin_tree,
    "src": core_src_tree,
    "web": core_web_tree,
}
manifest["source_trees"]["connectors"]["perfetto"] = {
    "plugin": plugin_tree,
    "adapter": adapter_tree,
}
manifest["source_trees"]["desktop"] = {"embedded_sdk": embedded_sdk_tree}
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

# 서명 검증 여부는 producer가 manifest에서 주장할 수 있는 상태가 아니다. 구 필드를
# 다시 넣고 checksum까지 맞춘 bundle도 greenfield schema에서 거부해야 한다.
forged_signature_dir="$test_root/forged-signature-claim"
cp -R -- "$release_dir" "$forged_signature_dir"
python3 - "$forged_signature_dir/release-manifest.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
manifest = json.loads(path.read_text(encoding="utf-8"))
manifest["release"]["signed_tag_verified"] = True
path.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
for artifact in \
  "$release_tag.bundle" release-manifest.json source-inventory.txt \
  history-inventory.txt tag-metadata.txt dependency-manifest.txt; do
  printf '%s  %s\n' "$(sha256_file "$forged_signature_dir/$artifact")" "$artifact"
done > "$forged_signature_dir/SHA256SUMS"
set +e
forged_signature_output=$("$fixture/scripts/perfetto/verify-release.sh" \
  "$forged_signature_dir" 2>&1)
forged_signature_status=$?
set -e
[ "$forged_signature_status" -ne 0 ] || \
  die "검증하지 않은 signed_tag_verified producer 주장을 허용했습니다"
printf '%s\n' "$forged_signature_output" | grep -Fq 'release 필드 집합 불일치'

# Embedded desktop은 한 package의 host/stdio/registrar 결합이 release 계약이다.
# version 문자열만 남은 불완전한 SDK가 정상 release가 되는 회귀를 막는다.
missing_runtime_repo="$test_root/missing-embedded-runtime"
git clone --quiet --no-hardlinks "$fixture" "$missing_runtime_repo"
git -C "$missing_runtime_repo" config user.name 'RELU Release Smoke'
git -C "$missing_runtime_repo" config user.email 'relu-release-smoke@example.invalid'
rm -- "$missing_runtime_repo/sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedBridgeHost.cs" \
  "$missing_runtime_repo/sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluMcpStdioEntryPoint.cs" \
  "$missing_runtime_repo/sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs"
git -C "$missing_runtime_repo" add -u
git -C "$missing_runtime_repo" commit -qm 'missing embedded runtime regression fixture'
git -C "$missing_runtime_repo" tag -f -a "$release_tag" \
  -m "missing embedded runtime $release_tag" >/dev/null
set +e
missing_runtime_output=$("$missing_runtime_repo/scripts/perfetto/create-release.sh" \
  --tag "$release_tag" --output "$test_root/missing-runtime-release" 2>&1)
missing_runtime_status=$?
set -e
[ "$missing_runtime_status" -ne 0 ] || \
  die "핵심 embedded runtime source가 빠진 release를 생성했습니다"
printf '%s\n' "$missing_runtime_output" | \
  grep -Eq 'tagged blob read|required blob type|\.NET embedded runtime source inventory'

# Manifest tree OID가 producer와 self-consistent해도 실제 실행 진입점이 빠지면 release가
# 아니다. Root CLI와 그 package bin 참조를 trusted verifier의 필수 inventory로 고정한다.
missing_cli_repo="$test_root/missing-root-cli"
git clone --quiet --no-hardlinks "$fixture" "$missing_cli_repo"
git -C "$missing_cli_repo" config user.name 'RELU Release Smoke'
git -C "$missing_cli_repo" config user.email 'relu-release-smoke@example.invalid'
git -C "$missing_cli_repo" rm -q bin/relu-ai-bridge.mjs
git -C "$missing_cli_repo" commit -qm 'missing root CLI regression fixture'
git -C "$missing_cli_repo" tag -f -a "$release_tag" \
  -m "missing root CLI $release_tag" >/dev/null
set +e
missing_cli_output=$("$missing_cli_repo/scripts/perfetto/create-release.sh" \
  --tag "$release_tag" --output "$test_root/missing-cli-release" 2>&1)
missing_cli_status=$?
set -e
[ "$missing_cli_status" -ne 0 ] || die "root CLI가 빠진 release를 생성했습니다"
printf '%s\n' "$missing_cli_output" | \
  grep -Eq 'core runtime source inventory|required blob type|root package bin|tagged 필수 source tree 누락: bin'

# Greenfield embedded 설계에서 삭제한 중앙 desktop token/service 표면은 이름만 다시
# 들어와도 거부한다. Producer manifest가 새 tree OID를 적는 것으로 우회할 수 없다.
legacy_repo="$test_root/reintroduced-legacy-desktop"
git clone --quiet --no-hardlinks "$fixture" "$legacy_repo"
git -C "$legacy_repo" config user.name 'RELU Release Smoke'
git -C "$legacy_repo" config user.email 'relu-release-smoke@example.invalid'
mkdir -p -- "$legacy_repo/config"
printf '%s\n' '{"legacy":true}' > \
  "$legacy_repo/compat/desktop-auth-v1.json"
printf '%s\n' '{"legacy":true}' > \
  "$legacy_repo/config/android-log-viewer.desktop.service.example.json"
git -C "$legacy_repo" add compat/desktop-auth-v1.json \
  config/android-log-viewer.desktop.service.example.json
git -C "$legacy_repo" commit -qm 'reintroduced legacy desktop regression fixture'
git -C "$legacy_repo" tag -f -a "$release_tag" \
  -m "reintroduced legacy desktop $release_tag" >/dev/null
set +e
legacy_output=$("$legacy_repo/scripts/perfetto/create-release.sh" \
  --tag "$release_tag" --output "$test_root/legacy-release" 2>&1)
legacy_status=$?
set -e
[ "$legacy_status" -ne 0 ] || die "삭제된 legacy desktop 표면이 있는 release를 생성했습니다"
printf '%s\n' "$legacy_output" | grep -Fq 'forbidden legacy desktop path'

# 대소문자 비구분 Windows checkout에서 덮어쓰기가 생기는 tree도 반입 전에 거부한다.
case_collision_repo="$test_root/case-collision"
git clone --quiet --no-hardlinks "$fixture" "$case_collision_repo"
git -C "$case_collision_repo" config user.name 'RELU Release Smoke'
git -C "$case_collision_repo" config user.email 'relu-release-smoke@example.invalid'
readme_blob=$(git -C "$case_collision_repo" rev-parse HEAD:README.md)
printf '100644 %s\tREADME.MD\n' "$readme_blob" | \
  git -C "$case_collision_repo" update-index --add --index-info
git -C "$case_collision_repo" commit -qm 'case collision regression fixture'
git -C "$case_collision_repo" tag -f -a "$release_tag" \
  -m "case collision $release_tag" >/dev/null
case_collision_release="$test_root/case-collision-release"
create_external_drift_release_fixture \
  "$case_collision_repo" "$release_tag" "$case_collision_release" \
  "$release_dir/release-manifest.json"
set +e
case_collision_output=$("$fixture/scripts/perfetto/verify-release.sh" \
  "$case_collision_release" 2>&1)
case_collision_status=$?
set -e
[ "$case_collision_status" -ne 0 ] || die "case-collision release를 허용했습니다"
printf '%s\n' "$case_collision_output" | grep -Fq 'case/Unicode path collision'

git init --bare -q "$test_root/mirror.git"
"$fixture/scripts/perfetto/import-release.sh" \
  "$release_dir" "$test_root/mirror.git" >/dev/null
"$fixture/scripts/perfetto/import-release.sh" \
  "$release_dir" "$test_root/mirror.git" >/dev/null

# 릴리스 경계 검사가 root/SDK/extension/plugin/MCP/health/web/.NET version drift를 놓치지
# 않는지 각각 회귀 검증한다. Source fixture는 올바른 값을 주석에 남겨 단순 문자열
# 검색이 실제 선언 drift를 가리는 경우도 함께 재현한다.
for version_drift_case in root sdk extension plugin mcp health web-default dotnet-embedded-default dotnet-embedded-default-decoy dotnet-stdio-protocol dotnet-stdio-discover dotnet-operation-id-bounds dotnet-registrar-path-override dotnet-registrar-local-mutex dotnet-codex-install-candidate dotnet-version-namespace dotnet-package-override dotnet-directory-override; do
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
    dotnet-embedded-default)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedServiceDefinition.cs
      version_drift_label='.NET embedded service default version'
      version_drift_kind=source
      ;;
    dotnet-embedded-default-decoy)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedServiceDefinition.cs
      version_drift_label='.NET embedded service version declaration count'
      version_drift_kind=source
      ;;
    dotnet-stdio-protocol)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluMcpStdioEntryPoint.cs
      version_drift_label='.NET embedded MCP protocol version'
      version_drift_kind=source
      ;;
    dotnet-stdio-discover)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluMcpStdioEntryPoint.cs
      version_drift_label='.NET embedded MCP obsolete discovery contract'
      version_drift_kind=source
      ;;
    dotnet-operation-id-bounds)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedBridgeHost.cs
      version_drift_label='.NET embedded operationId bounds'
      version_drift_kind=source
      ;;
    dotnet-registrar-path-override)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs
      version_drift_label='.NET registrar public executable path override'
      version_drift_kind=source
      ;;
    dotnet-registrar-local-mutex)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs
      version_drift_label='.NET cross-session registrar mutex scope'
      version_drift_kind=source
      ;;
    dotnet-codex-install-candidate)
      version_drift_path=sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs
      version_drift_label='.NET official Codex install candidate'
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
        "dotnet-embedded-default": (
            f'        string version = "{version}",',
            '        string version = "9.9.9",\n'
            "        /*\n"
            f'        string version = "{version}",\n'
            "        */",
        ),
        "dotnet-embedded-default-decoy": (
            f'        string version = "{version}",',
            '        string version = "9.9.9",',
        ),
        "dotnet-stdio-protocol": (
            '    private const string ProtocolVersion = "2025-06-18";',
            '    private const string ProtocolVersion = "2026-07-28";',
        ),
        "dotnet-stdio-discover": (
            "public static class ReluMcpStdioEntryPoint\n{",
            "public static class ReluMcpStdioEntryPoint\n{\n"
            '    private const string ObsoleteDiscoveryMethod = "server/discover";',
        ),
        "dotnet-operation-id-bounds": (
            'OptionalString(arguments, "operationId", 128, minimumLength: 8)',
            'OptionalString(arguments, "operationId", 128, minimumLength: 1)',
        ),
        "dotnet-registrar-path-override": (
            "public sealed class ReluAgentRegistrationOptions\n{",
            "public sealed class ReluAgentRegistrationOptions\n{\n"
            '    public string ExecutablePath { get; init; } = "C:\\\\override.exe";',
        ),
        "dotnet-registrar-local-mutex": (
            'return $"Global\\\\Relu.AI.Bridge.EndViewer.McpRegistration.',
            'return $"Local\\\\Relu.AI.Bridge.EndViewer.McpRegistration.',
        ),
        "dotnet-codex-install-candidate": (
            'Path.Combine(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),',
            'Path.Combine(localAppData, "Programs", "OpenAI", "Codex", "codex.exe"),',
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
    if case == "dotnet-embedded-default-decoy":
        updated += (
            "\ninternal sealed class ReluEmbeddedVersionGateDecoy\n"
            "{\n"
            "    public ReluEmbeddedVersionGateDecoy(\n"
            f'        string version = "{version}")\n'
            "    {\n"
            "    }\n"
            "}\n"
        )
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
cp -- "$fixture/integration/patches/perfetto-v58.2-enable-default-plugin.patch" \
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

# Integration/build evidence는 구조만이 아니라 대상 Git HEAD에 결합되어야 한다.
# 임의 company commit은 명시한 expected-head에서만 허용하고 public 기본값으로는 거부한다.
head_binding_repo="$test_root/head-binding-perfetto"
git -C "$test_root" init -q "$head_binding_repo"
git -C "$head_binding_repo" config user.name 'RELU Head Binding'
git -C "$head_binding_repo" config user.email 'relu-head-binding@example.invalid'
mkdir -p -- "$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge" \
  "$head_binding_repo/ui/src/perfetto_adapter/v58" \
  "$head_binding_repo/ui/src/core/embedder" \
  "$head_binding_repo/ui/src/base" \
  "$head_binding_repo/tools"
cp -R -- "$fixture/plugin/io.company.RELUPerfettoBridge/." \
  "$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/"
cp -R -- "$fixture/perfetto_adapter/." "$head_binding_repo/ui/src/perfetto_adapter/"
printf '%s\n' 'managed-by=relu-ai-bridge' 'connector=perfetto' 'mode=copy' > \
  "$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/.relu-ai-bridge-managed"
printf '%s\n' 'managed-by=relu-ai-bridge' 'connector=perfetto' 'mode=copy' > \
  "$head_binding_repo/ui/src/perfetto_adapter/.relu-ai-bridge-managed"
printf "%s\n" "export const defaultPlugins = [" \
  "  'io.company.RELUPerfettoBridge'," "] as const;" > \
  "$head_binding_repo/ui/src/core/embedder/default_plugins.ts"
printf '%s\n' 'export const perfettoBase = true;' > \
  "$head_binding_repo/ui/src/base/stable.ts"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "v22.0.0"' > \
  "$head_binding_repo/ui/node"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [ -n "${RELU_SMOKE_MUTATE_PATH:-}" ]; then printf "%s\n" "mutated" >> "$RELU_SMOKE_MUTATE_PATH"; fi' \
  'exit "${RELU_SMOKE_BUILD_EXIT:-0}"' > "$head_binding_repo/ui/build"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [ -n "${RELU_SMOKE_INSTALL_MUTATE_PATH:-}" ]; then printf "%s\n" "mutated" >> "$RELU_SMOKE_INSTALL_MUTATE_PATH"; fi' \
  'exit "${RELU_SMOKE_INSTALL_EXIT:-0}"' > \
  "$head_binding_repo/tools/install-build-deps"
chmod +x "$head_binding_repo/ui/node" "$head_binding_repo/ui/build" \
  "$head_binding_repo/tools/install-build-deps"
git -C "$head_binding_repo" add .
git -C "$head_binding_repo" commit -qm 'arbitrary company Perfetto fixture'
head_binding_commit=$(git -C "$head_binding_repo" rev-parse HEAD)
"$fixture/scripts/perfetto/verify-integration.sh" --target company \
  --expected-head "$head_binding_commit" "$head_binding_repo" >/dev/null
set +e
public_head_output=$("$fixture/scripts/perfetto/verify-integration.sh" \
  "$head_binding_repo" 2>&1)
public_head_status=$?
company_unbound_output=$("$fixture/scripts/perfetto/verify-integration.sh" \
  --target company "$head_binding_repo" 2>&1)
company_unbound_status=$?
set -e
[ "$public_head_status" -ne 0 ] || die "임의 Perfetto HEAD를 public v58.2로 허용했습니다"
printf '%s\n' "$public_head_output" | grep -Fq 'HEAD 불일치'
[ "$company_unbound_status" -ne 0 ] || die "expected-head 없는 company 검증을 허용했습니다"
printf '%s\n' "$company_unbound_output" | grep -Fq '40자리 --expected-head가 필요합니다'

integration_verify=("$fixture/scripts/perfetto/verify-integration.sh" \
  --target company --expected-head "$head_binding_commit")
integration_build=("$fixture/scripts/perfetto/build-test.sh" \
  --target company --expected-head "$head_binding_commit")
stable_path="$head_binding_repo/ui/src/base/stable.ts"

before_fingerprint=$("${integration_verify[@]}" --fingerprint "$head_binding_repo")
after_fingerprint=$("${integration_verify[@]}" --fingerprint "$head_binding_repo")
[ "$before_fingerprint" = "$after_fingerprint" ] || \
  die "동일 integration input의 fingerprint가 비결정적입니다"
"${integration_build[@]}" --typecheck "$head_binding_repo" >/dev/null

# Index와 worktree diff가 서로 상쇄되는 staged-only 변경도 별도 index 검사로 거부한다.
printf '%s\n' 'export const perfettoBase = false;' > "$stable_path"
git -C "$head_binding_repo" add ui/src/base/stable.ts
git -C "$head_binding_repo" show HEAD:ui/src/base/stable.ts > "$stable_path"
set +e
staged_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
staged_drift_status=$?
set -e
[ "$staged_drift_status" -ne 0 ] || die "staged-only integration drift를 허용했습니다"
printf '%s\n' "$staged_drift_output" | grep -Fq 'staged drift is not allowed'
git -C "$head_binding_repo" restore --source=HEAD --staged --worktree -- \
  ui/src/base/stable.ts

git -C "$head_binding_repo" update-index --assume-unchanged ui/src/base/stable.ts
set +e
assume_unchanged_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
assume_unchanged_status=$?
set -e
[ "$assume_unchanged_status" -ne 0 ] || die "assume-unchanged index 우회를 허용했습니다"
printf '%s\n' "$assume_unchanged_output" | \
  grep -Fq 'skip-worktree/assume-unchanged index entry'
git -C "$head_binding_repo" update-index --no-assume-unchanged ui/src/base/stable.ts

git -C "$head_binding_repo" update-index --skip-worktree ui/src/base/stable.ts
set +e
skip_worktree_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
skip_worktree_status=$?
set -e
[ "$skip_worktree_status" -ne 0 ] || die "skip-worktree index 우회를 허용했습니다"
printf '%s\n' "$skip_worktree_output" | \
  grep -Fq 'skip-worktree/assume-unchanged index entry'
git -C "$head_binding_repo" update-index --no-skip-worktree ui/src/base/stable.ts

base_blob=$(git -C "$head_binding_repo" rev-parse HEAD:ui/src/base/stable.ts)
ours_blob=$(printf '%s\n' 'ours conflict' | git -C "$head_binding_repo" hash-object -w --stdin)
theirs_blob=$(printf '%s\n' 'theirs conflict' | git -C "$head_binding_repo" hash-object -w --stdin)
git -C "$head_binding_repo" update-index --force-remove ui/src/base/stable.ts
printf '100644 %s 1\tui/src/base/stable.ts\n100644 %s 2\tui/src/base/stable.ts\n100644 %s 3\tui/src/base/stable.ts\n' \
  "$base_blob" "$ours_blob" "$theirs_blob" | \
  git -C "$head_binding_repo" update-index --index-info
set +e
unmerged_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
unmerged_status=$?
set -e
[ "$unmerged_status" -ne 0 ] || die "unmerged index 우회를 허용했습니다"
printf '%s\n' "$unmerged_output" | grep -Fq 'unmerged index entries'
git -C "$head_binding_repo" restore --source=HEAD --staged --worktree -- \
  ui/src/base/stable.ts

printf '%s\n' 'tracked drift' >> "$stable_path"
set +e
tracked_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
tracked_drift_status=$?
set -e
[ "$tracked_drift_status" -ne 0 ] || die "overlay 밖 tracked drift를 허용했습니다"
printf '%s\n' "$tracked_drift_output" | grep -Fq 'unexpected tracked drift'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- ui/src/base/stable.ts

printf '%s\n' 'untracked drift' > "$head_binding_repo/ui/src/unexpected.ts"
set +e
untracked_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
untracked_drift_status=$?
set -e
[ "$untracked_drift_status" -ne 0 ] || die "overlay 밖 untracked drift를 허용했습니다"
printf '%s\n' "$untracked_drift_output" | grep -Fq 'unexpected untracked drift'
rm -- "$head_binding_repo/ui/src/unexpected.ts"

printf '%s\n' '/out/' >> "$head_binding_repo/.git/info/exclude"
mkdir -p -- "$head_binding_repo/out/ui"
printf '%s\n' 'expected generated output' > "$head_binding_repo/out/ui/generated.js"
"${integration_verify[@]}" "$head_binding_repo" >/dev/null

# Perfetto의 /out* ignore pattern이 /outside-malicious도 숨기는 prefix 우회를 막는다.
printf '%s\n' '/outside-malicious/' >> "$head_binding_repo/.git/info/exclude"
mkdir -p -- "$head_binding_repo/outside-malicious"
printf '%s\n' 'ignored drift' > "$head_binding_repo/outside-malicious/preload.js"
set +e
ignored_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
ignored_drift_status=$?
set -e
[ "$ignored_drift_status" -ne 0 ] || die "허용 root를 흉내 낸 ignored drift를 허용했습니다"
printf '%s\n' "$ignored_drift_output" | grep -Fq 'unexpected ignored drift'
rm -rf -- "$head_binding_repo/outside-malicious"

plugin_fixture_path="$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/index.ts"
printf '%s\n' 'plugin mutation' >> "$plugin_fixture_path"
set +e
plugin_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
plugin_drift_status=$?
set -e
[ "$plugin_drift_status" -ne 0 ] || die "RELU plugin payload drift를 허용했습니다"
printf '%s\n' "$plugin_drift_output" | grep -Fq 'plugin copy inventory'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- \
  ui/src/plugins/io.company.RELUPerfettoBridge/index.ts

relu_plugin_fixture="$fixture/plugin/io.company.RELUPerfettoBridge/index.ts"
printf '%s\n' 'joint source mutation' >> "$relu_plugin_fixture"
printf '%s\n' 'joint source mutation' >> "$plugin_fixture_path"
set +e
joint_plugin_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
joint_plugin_status=$?
set -e
[ "$joint_plugin_status" -ne 0 ] || die "RELU source+target 동시 plugin drift를 허용했습니다"
printf '%s\n' "$joint_plugin_output" | \
  grep -Fq 'plugin source differs from RELU committed HEAD tree'
git -C "$fixture" restore --source=HEAD --worktree -- \
  plugin/io.company.RELUPerfettoBridge/index.ts
git -C "$head_binding_repo" restore --source=HEAD --worktree -- \
  ui/src/plugins/io.company.RELUPerfettoBridge/index.ts

default_fixture_path="$head_binding_repo/ui/src/core/embedder/default_plugins.ts"
printf '%s\n' '// extra default mutation' >> "$default_fixture_path"
set +e
default_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
default_drift_status=$?
set -e
[ "$default_drift_status" -ne 0 ] || die "default_plugins 추가 drift를 허용했습니다"
printf '%s\n' "$default_drift_output" | grep -Fq 'default_plugins is not the exact'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- \
  ui/src/core/embedder/default_plugins.ts

printf '%s\n' '/ui/src/plugins/io.company.RELUPerfettoBridge/ignored-extra.ts' >> \
  "$head_binding_repo/.git/info/exclude"
printf '%s\n' 'ignored overlay drift' > \
  "$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/ignored-extra.ts"
set +e
ignored_overlay_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
ignored_overlay_status=$?
set -e
[ "$ignored_overlay_status" -ne 0 ] || die "ignored overlay drift를 허용했습니다"
printf '%s\n' "$ignored_overlay_output" | grep -Fq 'plugin copy inventory'
rm -- "$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/ignored-extra.ts"

plugin_marker="$head_binding_repo/ui/src/plugins/io.company.RELUPerfettoBridge/.relu-ai-bridge-managed"
printf '%s\n' 'unapproved=marker-field' >> "$plugin_marker"
set +e
marker_drift_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
marker_drift_status=$?
set -e
[ "$marker_drift_status" -ne 0 ] || die "overlay marker drift를 허용했습니다"
printf '%s\n' "$marker_drift_output" | grep -Fq 'plugin marker'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- \
  ui/src/plugins/io.company.RELUPerfettoBridge/.relu-ai-bridge-managed

# Installer와 build가 실패해도 변경 후 검증을 생략하면 안 된다.
set +e
install_mutation_output=$(RELU_SMOKE_INSTALL_MUTATE_PATH="$stable_path" \
  "${integration_build[@]}" --install-deps --typecheck "$head_binding_repo" 2>&1)
install_mutation_status=$?
set -e
[ "$install_mutation_status" -ne 0 ] || die "installer source mutation을 허용했습니다"
printf '%s\n' "$install_mutation_output" | grep -Fq 'dependency installer가 integration source 계약을 변경했습니다'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- ui/src/base/stable.ts

set +e
build_mutation_output=$(RELU_SMOKE_MUTATE_PATH="$stable_path" \
  "${integration_build[@]}" --typecheck "$head_binding_repo" 2>&1)
build_mutation_status=$?
set -e
[ "$build_mutation_status" -ne 0 ] || die "성공한 build의 source mutation을 허용했습니다"
printf '%s\n' "$build_mutation_output" | grep -Fq '실행 뒤 integration 계약이 변경되었습니다'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- ui/src/base/stable.ts

set +e
clean_failed_build_output=$(RELU_SMOKE_BUILD_EXIT=7 \
  "${integration_build[@]}" --typecheck "$head_binding_repo" 2>&1)
clean_failed_build_status=$?
set -e
[ "$clean_failed_build_status" -eq 7 ] || \
  die "실패 후 계약이 정상인 build의 원래 exit 7을 보존하지 않았습니다"
printf '%s\n' "$clean_failed_build_output" | grep -Fq 'Perfetto UI typecheck 실패(exit 7)'

set +e
failed_build_mutation_output=$(RELU_SMOKE_MUTATE_PATH="$stable_path" \
  RELU_SMOKE_BUILD_EXIT=7 "${integration_build[@]}" --typecheck \
  "$head_binding_repo" 2>&1)
failed_build_mutation_status=$?
set -e
[ "$failed_build_mutation_status" -ne 0 ] || die "실패한 build의 source mutation을 허용했습니다"
printf '%s\n' "$failed_build_mutation_output" | \
  grep -Fq '실행 뒤 integration 계약이 변경되었습니다'
git -C "$head_binding_repo" restore --source=HEAD --worktree -- ui/src/base/stable.ts

# 설치된 company adapter는 target 내부 marker가 아니라 별도 승인 source와 digest에
# 묶는다. Target/source를 함께 바꾸어도 기존 외부 승인 digest로는 통과하지 못한다.
company_adapter_source="$test_root/company-adapter-source"
mkdir -p -- "$company_adapter_source"
printf '%s\n' 'export const companyAdapter = true;' > "$company_adapter_source/index.ts"
printf '%s\n' 'export const approved = true;' > "$company_adapter_source/extra.ts"
printf '%s\n' '{' '  "schema_version": 1,' \
  "  \"company_perfetto_commit\": \"$head_binding_commit\"," \
  '  "base_adapter": "v58"' '}' > "$company_adapter_source/COMPANY_ADAPTER.json"
company_adapter_sha256=$("$fixture/scripts/perfetto/overlay-company-adapter.sh" \
  --print-source-sha256 "$company_adapter_source")
"$fixture/scripts/perfetto/overlay-company-adapter.sh" \
  "$company_adapter_source" "$head_binding_repo" "$head_binding_commit" \
  "$company_adapter_sha256" >/dev/null
company_verify=("${integration_verify[@]}" \
  --company-adapter-dir "$company_adapter_source" \
  --expected-company-adapter-sha256 "$company_adapter_sha256")
"${company_verify[@]}" "$head_binding_repo" >/dev/null

set +e
unbound_adapter_output=$("${integration_verify[@]}" "$head_binding_repo" 2>&1)
unbound_adapter_status=$?
set -e
[ "$unbound_adapter_status" -ne 0 ] || die "승인 source/digest 없는 company adapter를 허용했습니다"
printf '%s\n' "$unbound_adapter_output" | grep -Fq 'requires --company-adapter-dir'

company_target_extra="$head_binding_repo/ui/src/perfetto_adapter/v58/extra.ts"
printf '%s\n' 'target-only mutation' >> "$company_target_extra"
set +e
company_target_output=$("${company_verify[@]}" "$head_binding_repo" 2>&1)
company_target_status=$?
set -e
[ "$company_target_status" -ne 0 ] || die "company adapter target drift를 허용했습니다"
printf '%s\n' "$company_target_output" | grep -Fq 'differs from trusted source'
printf '%s\n' 'export const approved = true;' > "$company_target_extra"

printf '%s\n' 'joint mutation' >> "$company_adapter_source/extra.ts"
printf '%s\n' 'joint mutation' >> "$company_target_extra"
set +e
joint_adapter_output=$("${company_verify[@]}" "$head_binding_repo" 2>&1)
joint_adapter_status=$?
set -e
[ "$joint_adapter_status" -ne 0 ] || die "company adapter source+target 동시 drift를 허용했습니다"
printf '%s\n' "$joint_adapter_output" | grep -Fq 'differs from external approval'

info "release security smoke test 통과"
info "정상 version/branding/create/verify/import와 core/embedded inventory, signature claim, exact HEAD/overlay/build fingerprint, company adapter approval, producer/inbound/import drift·hidden object·credential·linked worktree·legacy/case collision·추가 patch hunk 거부를 확인했습니다"
