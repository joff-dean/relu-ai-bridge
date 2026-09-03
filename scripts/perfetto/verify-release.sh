#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
umask 077

MAX_RELEASE_BUNDLE_BYTES=536870912
MAX_MANIFEST_BYTES=4194304
MAX_INVENTORY_BYTES=134217728

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/verify-release.sh [--require-signed-tag] \
    [--sanitized-bundle OUTPUT.bundle] RELEASE_DIR

extra head/object를 포함한 bundle을 거부한다. --sanitized-bundle을 지정하면 검역용
빈 저장소에서 exact annotated tag만 다시 묶은 안전한 전달본을 새 경로에 생성한다.
EOF
}

require_signed=0
sanitized_bundle=
release_argument=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --require-signed-tag) require_signed=1; shift ;;
    --sanitized-bundle)
      [ "$#" -ge 2 ] || die "--sanitized-bundle 값이 필요합니다"
      sanitized_bundle=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    --*) die "알 수 없는 옵션: $1" ;;
    *)
      [ -z "$release_argument" ] || die "RELEASE_DIR은 하나만 지정하십시오"
      release_argument=$1
      shift
      ;;
  esac
done
[ -n "$release_argument" ] || { usage >&2; exit 2; }

require_command git
require_command python3
require_command cmp
assert_compatibility_alignment
[ ! -L "$release_argument" ] || die "RELEASE_DIR symlink를 허용하지 않습니다"
release_dir=$(canonical_existing_dir "$release_argument")

for required in SHA256SUMS release-manifest.json source-inventory.txt \
  history-inventory.txt tag-metadata.txt dependency-manifest.txt; do
  [ -f "$release_dir/$required" ] && [ ! -L "$release_dir/$required" ] || \
    die "필수 릴리스 일반 파일 누락: $required"
done

small_size=$(wc -c < "$release_dir/release-manifest.json" | tr -d '[:space:]')
[ "$small_size" -le "$MAX_MANIFEST_BYTES" ] || die "release manifest 크기 상한 초과"
for inventory in source-inventory.txt history-inventory.txt tag-metadata.txt \
  dependency-manifest.txt SHA256SUMS; do
  inventory_size=$(wc -c < "$release_dir/$inventory" | tr -d '[:space:]')
  [ "$inventory_size" -le "$MAX_INVENTORY_BYTES" ] || \
    die "릴리스 metadata 크기 상한 초과: $inventory"
done

manifest_values=$(python3 - "$release_dir/release-manifest.json" "$release_dir" \
  "$MAX_RELEASE_BUNDLE_BYTES" "$RELU_COMPAT_FILE" "$PERFETTO_COMPAT_FILE" <<'PY'
import json
import pathlib
import re
import sys

manifest_path = pathlib.Path(sys.argv[1])
release_dir = pathlib.Path(sys.argv[2])
max_bundle = int(sys.argv[3])
relu_contract = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))
connector_contract = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("중복 JSON key 발견")
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError("비표준 JSON number 발견")

data = json.loads(
    manifest_path.read_text(encoding="utf-8"),
    object_pairs_hook=reject_duplicates,
    parse_constant=reject_constant,
)

def exact_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise SystemExit(f"{label} 필드 집합 불일치")

exact_keys(
    data,
    [
        "schema_version", "project", "product", "release", "artifact",
        "compatibility", "source_trees", "security",
    ],
    "manifest",
)
if data.get("schema_version") != 2 or data.get("project") != "relu-ai-bridge":
    raise SystemExit("지원하지 않는 RELU release manifest")
exact_keys(data["product"], ["name", "core_version"], "product")
if data.get("product", {}).get("name") != "RELU AI Bridge":
    raise SystemExit("RELU 제품명 불일치")
core_version = data["product"]["core_version"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", core_version):
    raise SystemExit("core version 형식 오류")
if data["product"] != {
    "name": relu_contract["product"]["name"],
    "core_version": relu_contract["product"]["core_version"],
}:
    raise SystemExit("현재 RELU core contract와 product 선언 불일치")

release = data["release"]
exact_keys(
    release,
    [
        "tag", "tag_object", "commit", "created_utc", "annotated_tag",
    ],
    "release",
)
tag = release["tag"]
tag_object = release["tag_object"]
commit = release["commit"]
if tag != f"relu-ai-bridge-v{core_version}":
    raise SystemExit("release tag와 core version 불일치")
if not re.fullmatch(r"[0-9a-f]{40}", tag_object):
    raise SystemExit("tag object가 정확한 SHA-1이 아님")
if not re.fullmatch(r"[0-9a-f]{40}", commit):
    raise SystemExit("release commit이 정확한 SHA-1이 아님")
if release.get("annotated_tag") is not True:
    raise SystemExit("annotated tag 선언 누락")
if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", release["created_utc"]):
    raise SystemExit("release 생성 시각 형식 오류")

artifact = data["artifact"]
exact_keys(
    artifact,
    ["git_bundle", "sha256", "size_bytes", "advertised_heads", "object_scope"],
    "artifact",
)
bundle = artifact["git_bundle"]
bundle_sha = artifact["sha256"]
bundle_size = artifact["size_bytes"]
tag_ref = f"refs/tags/{tag}"
if bundle != f"{tag}.bundle" or pathlib.Path(bundle).name != bundle:
    raise SystemExit("bundle 이름 불일치")
if not re.fullmatch(r"[0-9a-f]{64}", bundle_sha):
    raise SystemExit("bundle SHA-256 형식 오류")
if not isinstance(bundle_size, int) or not 0 < bundle_size <= max_bundle:
    raise SystemExit("bundle 크기 상한/형식 오류")
if artifact.get("advertised_heads") != [tag_ref]:
    raise SystemExit("bundle advertised head 선언 불일치")
if artifact.get("object_scope") != "exact-tag-reachable-only":
    raise SystemExit("bundle object scope 선언 불일치")

exact_keys(data["compatibility"], ["core_contract", "connectors"], "compatibility")
core = data["compatibility"]["core_contract"]
exact_keys(core, ["path", "blob"], "core contract")
connectors = data["compatibility"]["connectors"]
if len(connectors) != 1:
    raise SystemExit("지원 connector 집합 불일치")
connector = connectors[0]
exact_keys(
    connector,
    [
        "number", "id", "name", "version", "adapter_contract", "manifest_path",
        "contract_blob", "compatible_relu_core_versions", "public_baseline",
    ],
    "connector",
)
if connector.get("number") != 1 or connector.get("id") != "perfetto":
    raise SystemExit("Connector #1 Perfetto contract 불일치")
if core.get("path") != "compat/relu-ai-bridge.json":
    raise SystemExit("core compatibility path 불일치")
if connector.get("manifest_path") != "compat/connectors/perfetto-v58.2.json":
    raise SystemExit("Perfetto connector compatibility path 불일치")
expected_connector = connector_contract["connector"]
for manifest_key, contract_key in (
    ("number", "number"),
    ("id", "id"),
    ("name", "name"),
    ("version", "version"),
    ("adapter_contract", "adapter_contract"),
    ("compatible_relu_core_versions", "compatible_relu_core_versions"),
):
    if connector.get(manifest_key) != expected_connector.get(contract_key):
        raise SystemExit(f"connector contract 선언 불일치: {manifest_key}")
if connector.get("public_baseline") != connector_contract["public_baseline"]:
    raise SystemExit("public baseline 선언이 tagged connector contract와 다름")
exact_keys(
    connector["public_baseline"],
    [
        "repository", "release", "tag_ref", "tag_object_sha", "commit_sha",
        "short_commit",
    ],
    "public baseline",
)
exact_keys(data["source_trees"], ["core", "desktop", "connectors"], "source trees")
exact_keys(data["source_trees"]["core"], ["bin", "src", "web"], "core source trees")
exact_keys(data["source_trees"]["desktop"], ["embedded_sdk"], "desktop source trees")
exact_keys(data["source_trees"]["connectors"], ["perfetto"], "source connector trees")
exact_keys(
    data["source_trees"]["connectors"]["perfetto"],
    ["plugin", "adapter"],
    "Perfetto source trees",
)
exact_keys(
    data["security"],
    [
        "all_reachable_blob_scan", "raw_commit_and_tag_metadata_scan",
        "reachable_history_path_scan", "reachable_history_symlink_scan",
        "exact_bundle_head_check", "human_outbound_review_required",
    ],
    "security",
)
for name in (
    "all_reachable_blob_scan",
    "raw_commit_and_tag_metadata_scan",
    "reachable_history_path_scan",
    "reachable_history_symlink_scan",
    "exact_bundle_head_check",
):
    if data["security"].get(name) != "passed":
        raise SystemExit(f"security 상태 불일치: {name}")
if data["security"].get("human_outbound_review_required") is not True:
    raise SystemExit("human outbound review 선언 누락")
sha_fields = [
    core.get("blob", ""),
    connector.get("contract_blob", ""),
    connector["public_baseline"].get("tag_object_sha", ""),
    connector["public_baseline"].get("commit_sha", ""),
    data["source_trees"]["core"].get("bin", ""),
    data["source_trees"]["core"].get("src", ""),
    data["source_trees"]["core"].get("web", ""),
    data["source_trees"]["connectors"]["perfetto"].get("plugin", ""),
    data["source_trees"]["connectors"]["perfetto"].get("adapter", ""),
    data["source_trees"]["desktop"].get("embedded_sdk", ""),
]
if any(not re.fullmatch(r"[0-9a-f]{40}", item) for item in sha_fields):
    raise SystemExit("compatibility/source tree SHA 형식 오류")
if core_version not in connector.get("compatible_relu_core_versions", []):
    raise SystemExit("connector가 RELU core version을 지원하지 않음")

expected_files = {
    "SHA256SUMS",
    "release-manifest.json",
    "source-inventory.txt",
    "history-inventory.txt",
    "tag-metadata.txt",
    "dependency-manifest.txt",
    bundle,
}
actual_entries = {entry.name for entry in release_dir.iterdir()}
if actual_entries != expected_files:
    raise SystemExit("릴리스 디렉터리의 파일 집합이 허용 목록과 다름")
for name in expected_files:
    path = release_dir / name
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
        raise SystemExit(
            f"릴리스 항목은 hardlink/symlink가 아닌 단일 일반 파일이어야 함: {name}"
        )
if (release_dir / bundle).stat().st_size != bundle_size:
    raise SystemExit("bundle 실제 크기와 manifest 불일치")

sum_entries = []
for line in (release_dir / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
    parts = line.split("  ", 1)
    if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
        raise SystemExit("SHA256SUMS 형식 오류")
    if pathlib.PurePosixPath(parts[1]).name != parts[1]:
        raise SystemExit("SHA256SUMS 경로 오류")
    sum_entries.append(parts[1])
checksummed_files = expected_files - {"SHA256SUMS"}
if len(sum_entries) != len(set(sum_entries)) or set(sum_entries) != checksummed_files:
    raise SystemExit("SHA256SUMS 항목이 필수 파일 집합과 다름")

print(tag)
print(tag_object)
print(commit)
print(bundle)
print(bundle_sha)
print(bundle_size)
print(core_version)
print(core["path"])
print(core["blob"])
print(connector["manifest_path"])
print(connector["contract_blob"])
print(connector["public_baseline"]["tag_object_sha"])
print(connector["public_baseline"]["commit_sha"])
print(data["source_trees"]["core"]["bin"])
print(data["source_trees"]["core"]["src"])
print(data["source_trees"]["core"]["web"])
print(data["source_trees"]["connectors"]["perfetto"]["plugin"])
print(data["source_trees"]["connectors"]["perfetto"]["adapter"])
print(data["source_trees"]["desktop"]["embedded_sdk"])
PY
) || die "릴리스 구조 또는 release-manifest.json 검증 실패"

release_tag=$(printf '%s\n' "$manifest_values" | sed -n '1p')
tag_object=$(printf '%s\n' "$manifest_values" | sed -n '2p')
release_commit=$(printf '%s\n' "$manifest_values" | sed -n '3p')
bundle_name=$(printf '%s\n' "$manifest_values" | sed -n '4p')
manifest_bundle_sha=$(printf '%s\n' "$manifest_values" | sed -n '5p')
manifest_bundle_size=$(printf '%s\n' "$manifest_values" | sed -n '6p')
manifest_core_version=$(printf '%s\n' "$manifest_values" | sed -n '7p')
core_contract_path=$(printf '%s\n' "$manifest_values" | sed -n '8p')
manifest_core_blob=$(printf '%s\n' "$manifest_values" | sed -n '9p')
connector_contract_path=$(printf '%s\n' "$manifest_values" | sed -n '10p')
manifest_connector_blob=$(printf '%s\n' "$manifest_values" | sed -n '11p')
manifest_perfetto_tag_object=$(printf '%s\n' "$manifest_values" | sed -n '12p')
manifest_perfetto_commit=$(printf '%s\n' "$manifest_values" | sed -n '13p')
manifest_core_bin_tree=$(printf '%s\n' "$manifest_values" | sed -n '14p')
manifest_core_src_tree=$(printf '%s\n' "$manifest_values" | sed -n '15p')
manifest_core_web_tree=$(printf '%s\n' "$manifest_values" | sed -n '16p')
manifest_plugin_tree=$(printf '%s\n' "$manifest_values" | sed -n '17p')
manifest_adapter_tree=$(printf '%s\n' "$manifest_values" | sed -n '18p')
manifest_embedded_sdk_tree=$(printf '%s\n' "$manifest_values" | sed -n '19p')

[ "$release_tag" = "$(relu_value release.tag_prefix)$(relu_value product.core_version)" ] || \
  die "현재 RELU core contract와 release tag가 다릅니다"
[ "$manifest_core_version" = "$(relu_value product.core_version)" ] || \
  die "현재 RELU core version과 릴리스가 다릅니다"
[ "$manifest_perfetto_tag_object" = "$(compat_value public_baseline.tag_object_sha)" ] || \
  die "현재 도구의 Perfetto public tag contract와 릴리스가 다릅니다"
[ "$manifest_perfetto_commit" = "$(compat_value public_baseline.commit_sha)" ] || \
  die "현재 도구의 Perfetto public commit contract와 릴리스가 다릅니다"

actual_bundle_size=$(wc -c < "$release_dir/$bundle_name" | tr -d '[:space:]')
[ "$actual_bundle_size" = "$manifest_bundle_size" ] || die "bundle 크기 불일치"
[ "$actual_bundle_size" -le "$MAX_RELEASE_BUNDLE_BYTES" ] || die "bundle 크기 상한 초과"
verify_sha256_sums "$release_dir"
[ -f "$release_dir/SHA256SUMS" ] || die "SHA256SUMS가 사라졌습니다"
initial_sums_sha=$(sha256_file "$release_dir/SHA256SUMS")
[ "$(sha256_file "$release_dir/$bundle_name")" = "$manifest_bundle_sha" ] || \
  die "manifest의 bundle SHA-256과 실제 파일이 다릅니다"

tag_ref="refs/tags/$release_tag"
bundle_heads=$(git bundle list-heads "$release_dir/$bundle_name")
[ "$bundle_heads" = "$tag_object $tag_ref" ] || \
  die "bundle advertised head 집합이 exact release tag 하나가 아닙니다"

verify_root=$(mktemp -d /tmp/relu-ai-bridge-bundle-verify.XXXXXX)
verify_repo="$verify_root/repository.git"
sanitized_stage=
cleanup() {
  if [ -n "$sanitized_stage" ] && [ -d "$sanitized_stage" ]; then
    rm -rf -- "$sanitized_stage"
  fi
  rm -rf -- "$verify_root"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
git init --bare --quiet --template= "$verify_repo"
git -c transfer.fsckObjects=true -c fetch.fsckObjects=true -c gc.auto=0 \
  -c maintenance.auto=false -C "$verify_repo" \
  fetch --quiet --no-tags "$release_dir/$bundle_name" "$tag_ref:$tag_ref"

[ "$(git -C "$verify_repo" cat-file -t "$tag_ref")" = tag ] || \
  die "bundle release ref가 annotated tag object가 아닙니다"
[ "$(git -C "$verify_repo" rev-parse "$tag_ref")" = "$tag_object" ] || \
  die "bundle raw tag object가 manifest와 다릅니다"
[ "$(git -C "$verify_repo" rev-parse "$tag_ref^{}")" = "$release_commit" ] || \
  die "bundle tag의 peeled commit이 manifest와 다릅니다"
if [ "$require_signed" -eq 1 ]; then
  git -C "$verify_repo" verify-tag "$release_tag"
fi

# fetch는 요청 ref 외 pack object도 ODB에 넣으므로, 빈 검역 저장소의 전체 object
# 집합이 exact tag reachability와 완전히 같은지 검사한다.
git -C "$verify_repo" cat-file --batch-all-objects \
  --batch-check='%(objectname)' | LC_ALL=C sort -u > "$verify_root/all-objects.txt"
git -C "$verify_repo" rev-list --objects "$tag_ref" | \
  awk '{print $1}' | LC_ALL=C sort -u > "$verify_root/reachable-objects.txt"
cmp -s "$verify_root/all-objects.txt" "$verify_root/reachable-objects.txt" || \
  die "bundle에 exact release tag에서 도달할 수 없는 extra object가 있습니다"

# 생성측의 security=passed 선언을 신뢰하지 않고 반입측 도구로 다시 검역한다.
python3 "$SCRIPT_DIR/release-security-scan.py" \
  --repository "$verify_repo" --ref "$tag_ref"

# Inbound bundle의 실행 파일을 신뢰하거나 실행하지 않는다. 검역 bare repo의 고정된
# tagged blob만 읽어 모든 배포 표면의 제품명/version 계약을 독립 재계산한다.
python3 - "$verify_repo" "$tag_ref" "$manifest_core_version" <<'PY'
import hashlib
import json
import pathlib
import re
import shlex
import subprocess
import sys
import unicodedata
import xml.etree.ElementTree as ET

repository = pathlib.Path(sys.argv[1])
tag_ref = sys.argv[2]
core_version = sys.argv[3]
max_contract_blob_bytes = 4 * 1024 * 1024


def fail(label):
    raise SystemExit(f"inbound version/branding contract 불일치: {label}")


def git(*arguments):
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        fail("tagged blob read")
    return completed.stdout


def tagged_blob(path):
    spec = f"{tag_ref}:{path}"
    if git("cat-file", "-t", spec).strip() != b"blob":
        fail(f"required blob type: {path}")
    try:
        size = int(git("cat-file", "-s", spec))
    except ValueError:
        fail(f"required blob size: {path}")
    if not 0 <= size <= max_contract_blob_bytes:
        fail(f"required blob size: {path}")
    value = git("cat-file", "blob", spec)
    if len(value) != size:
        fail(f"required blob changed while reading: {path}")
    return value


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(_value):
    fail("non-standard JSON number")


def tagged_json(path):
    try:
        return json.loads(
            tagged_blob(path).decode("utf-8"),
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(f"invalid JSON: {path}")


def tagged_text(path):
    try:
        return tagged_blob(path).decode("utf-8")
    except UnicodeDecodeError:
        fail(f"invalid UTF-8 source: {path}")


def strip_javascript_comments(source, label):
    result = []
    state = "code"
    index = 0
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if character in ("'", '"', "`"):
                state = character
                result.append(character)
                index += 1
            elif character == "/" and following == "/":
                result.extend((" ", " "))
                state = "line-comment"
                index += 2
            elif character == "/" and following == "*":
                result.extend((" ", " "))
                state = "block-comment"
                index += 2
            else:
                result.append(character)
                index += 1
        elif state in ("'", '"', "`"):
            result.append(character)
            index += 1
            if character == "\\" and index < len(source):
                result.append(source[index])
                index += 1
            elif character == state:
                state = "code"
        elif state == "line-comment":
            result.append("\n" if character == "\n" else " ")
            index += 1
            if character == "\n":
                state = "code"
        else:
            if character == "*" and following == "/":
                result.extend((" ", " "))
                state = "code"
                index += 2
            else:
                result.append("\n" if character == "\n" else " ")
                index += 1
    if state in ("block-comment", "'", '"', "`"):
        fail(f"unterminated JavaScript token: {label}")
    return "".join(result)


def strip_csharp_comments(source, label):
    result = []
    state = "code"
    index = 0
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if character == "@" and following == '"':
                state = "verbatim"
                result.extend((character, following))
                index += 2
            elif character in ("'", '"'):
                state = character
                result.append(character)
                index += 1
            elif character == "/" and following == "/":
                result.extend((" ", " "))
                state = "line-comment"
                index += 2
            elif character == "/" and following == "*":
                result.extend((" ", " "))
                state = "block-comment"
                index += 2
            else:
                result.append(character)
                index += 1
        elif state == "verbatim":
            result.append(character)
            index += 1
            if character == '"' and following == '"':
                result.append(following)
                index += 1
            elif character == '"':
                state = "code"
        elif state in ("'", '"'):
            result.append(character)
            index += 1
            if character == "\\" and index < len(source):
                result.append(source[index])
                index += 1
            elif character == state:
                state = "code"
        elif state == "line-comment":
            result.append("\n" if character == "\n" else " ")
            index += 1
            if character == "\n":
                state = "code"
        else:
            if character == "*" and following == "/":
                result.extend((" ", " "))
                state = "code"
                index += 2
            else:
                result.append("\n" if character == "\n" else " ")
                index += 1
    if state in ("block-comment", "verbatim", "'", '"'):
        fail(f"unterminated C# token: {label}")
    return "".join(result)


def require_unique_regex(source, pattern, label, flags=0):
    if len(list(re.finditer(pattern, source, flags))) != 1:
        fail(label)


root_package = tagged_json("package.json")
sdk_package = tagged_json("sdk/package.json")
dotnet_project_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj")
dotnet_embedded_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedServiceDefinition.cs")
dotnet_host_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluEmbeddedBridgeHost.cs")
dotnet_stdio_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluMcpStdioEntryPoint.cs")
dotnet_registrar_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluAiClientRegistrar.cs")
dotnet_peer_source = tagged_text("sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Internal/EmbeddedPipePeerVerifier.cs")
skills_manifest = tagged_json("skills/manifest.json")
extension = tagged_json("extension/manifest.json")
web_connector_source = tagged_text("sdk/relu-web-connector.js")
plugin_source = tagged_text("plugin/io.company.RELUPerfettoBridge/index.ts")
mcp_source = tagged_text("src/mcp.mjs")
server_source = tagged_text("src/server.mjs")
plugin_code = strip_javascript_comments(plugin_source, "Perfetto plugin")
mcp_code = strip_javascript_comments(mcp_source, "MCP server")
server_code = strip_javascript_comments(server_source, "health server")
web_connector_code = strip_javascript_comments(web_connector_source, "web connector SDK")
if '@"' in dotnet_embedded_source or '@$"' in dotnet_embedded_source or '"""' in dotnet_embedded_source:
    fail(".NET embedded service unsupported string form")
if re.search(r"^[ \t]*#", dotnet_embedded_source, re.MULTILINE) is not None:
    fail(".NET embedded service preprocessor directive")
dotnet_embedded_code = strip_csharp_comments(dotnet_embedded_source, ".NET embedded service definition")
dotnet_host_code = strip_csharp_comments(dotnet_host_source, ".NET embedded bridge host")
dotnet_stdio_code = strip_csharp_comments(dotnet_stdio_source, ".NET embedded MCP stdio entry point")
dotnet_registrar_code = strip_csharp_comments(dotnet_registrar_source, ".NET AI client registrar")
dotnet_peer_code = strip_csharp_comments(dotnet_peer_source, ".NET named-pipe peer verifier")

embedded_root = "sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/"
expected_embedded_paths = {
    embedded_root + path for path in (
        "Internal/BoundedHandlerSlots.cs",
        "Internal/BoundedJson.cs",
        "Internal/EmbeddedContextProtocol.cs",
        "Internal/EmbeddedJsonSchema.cs",
        "Internal/EmbeddedPipePeerVerifier.cs",
        "Internal/EmbeddedPipeProtocol.cs",
        "Properties/AssemblyInfo.cs",
        "Relu.AI.Bridge.DesktopConnector.csproj",
        "ReluAiClientRegistrar.cs",
        "ReluDesktopCapability.cs",
        "ReluDesktopContext.cs",
        "ReluEmbeddedBridgeHost.cs",
        "ReluEmbeddedServiceDefinition.cs",
        "ReluMcpStdioEntryPoint.cs",
    )
}
actual_embedded_paths = set(
    git("ls-tree", "-r", "--name-only", tag_ref, "--", embedded_root.rstrip("/"))
    .decode("utf-8").splitlines()
)
if actual_embedded_paths != expected_embedded_paths:
    fail(".NET embedded runtime source inventory")

if not isinstance(root_package, dict) or root_package.get("name") != "relu-ai-bridge":
    fail("root package name")
if root_package.get("version") != core_version:
    fail("root package version")
if root_package.get("private") is not True or root_package.get("type") != "module":
    fail("root package private/module contract")
if not isinstance(sdk_package, dict) or sdk_package.get("name") != "@company/relu-ai-connector":
    fail("SDK package name")
if sdk_package.get("version") != core_version:
    fail("SDK package version")
if sdk_package.get("private") is not True or sdk_package.get("type") != "module":
    fail("SDK package private/module contract")
try:
    dotnet_project = ET.fromstring(dotnet_project_source)
except ET.ParseError:
    fail(".NET SDK project XML")
if dotnet_project.tag != "Project" or dotnet_project.attrib != {"Sdk": "Microsoft.NET.Sdk"}:
    fail(".NET SDK project root")
dotnet_elements = list(dotnet_project.iter())

def xml_local_name(tag):
    return tag.rsplit("}", 1)[-1].casefold()

def exact_unconditional_property(name, expected):
    all_nodes = [element for element in dotnet_elements if xml_local_name(element.tag) == name.casefold()]
    direct = []
    for group in list(dotnet_project):
        if xml_local_name(group.tag) != "propertygroup":
            continue
        for node in list(group):
            if xml_local_name(node.tag) == name.casefold():
                direct.append((group, node))
    if len(all_nodes) != 1 or len(direct) != 1:
        return False
    group, node = direct[0]
    return (group.tag == "PropertyGroup" and node.tag == name
        and not group.attrib and not node.attrib and not list(node)
        and (node.text or "").strip() == expected)

if not exact_unconditional_property("TargetFramework", "net8.0"):
    fail(".NET SDK target")
if not exact_unconditional_property("Version", core_version):
    fail(".NET SDK version")
for forbidden_property in ("TargetFrameworks", "PackageVersion", "VersionPrefix", "VersionSuffix"):
    if any(xml_local_name(element.tag) == forbidden_property.casefold() for element in dotnet_elements):
        fail(f".NET SDK forbidden override: {forbidden_property}")
for forbidden_element in ("Import", "ImportGroup", "Target", "UsingTask"):
    if any(xml_local_name(element.tag) == forbidden_element.casefold() for element in dotnet_elements):
        fail(f".NET SDK executable override: {forbidden_element}")
try:
    tagged_paths = git("ls-tree", "-r", "--name-only", "-z", tag_ref).decode("utf-8").split("\0")
except UnicodeDecodeError:
    fail("tagged path encoding")
tagged_paths = [path for path in tagged_paths if path]
tagged_path_set = {path.casefold() for path in tagged_paths}
normalized_paths = {}
for tagged_path in tagged_paths:
    normalized = unicodedata.normalize("NFC", tagged_path).casefold()
    if normalized in normalized_paths and normalized_paths[normalized] != tagged_path:
        fail(f"case/Unicode path collision: {normalized_paths[normalized]} / {tagged_path}")
    normalized_paths[normalized] = tagged_path

forbidden_legacy_paths = {
    "compat/desktop-auth-v1.json",
    "config/android-log-viewer.desktop.service.example.json",
    "examples/wpf-android-log-viewer/istableinstanceidprovider.cs",
    "sdk-dotnet/src/relu.ai.bridge.desktopconnector/internal/desktopwireprotocol.cs",
    "sdk-dotnet/src/relu.ai.bridge.desktopconnector/reluconnectorsecret.cs",
    "sdk-dotnet/src/relu.ai.bridge.desktopconnector/reludesktopconnector.cs",
    "sdk-dotnet/src/relu.ai.bridge.desktopconnector/reludesktopconnectoroptions.cs",
}
present_legacy = sorted(forbidden_legacy_paths.intersection(normalized_paths))
if present_legacy:
    fail(f"forbidden legacy desktop path: {present_legacy[0]}")

expected_core_runtime_paths = {
    "bin/relu-ai-bridge.mjs",
    "src/agents.mjs",
    "src/approvals.mjs",
    "src/audit.mjs",
    "src/bridge.mjs",
    "src/config.mjs",
    "src/connectors.mjs",
    "src/goal.mjs",
    "src/http-proof.mjs",
    "src/instance-lock.mjs",
    "src/json-schema.mjs",
    "src/ledger-maintenance.mjs",
    "src/mcp.mjs",
    "src/operation-ledger.mjs",
    "src/perfetto-broker.mjs",
    "src/perfetto-store.mjs",
    "src/perfetto-tools.mjs",
    "src/relu-tools.mjs",
    "src/security.mjs",
    "src/server.mjs",
    "src/sessions.mjs",
    "src/tools/commands.mjs",
    "src/tools/files.mjs",
    "src/utils.mjs",
    "src/websocket.mjs",
    "web/admin.css",
    "web/admin.html",
    "web/admin.js",
}
actual_core_runtime_paths = {
    path for path in tagged_paths
    if path == "bin" or path.startswith("bin/")
    or path == "src" or path.startswith("src/")
    or path == "web" or path.startswith("web/")
}
if actual_core_runtime_paths != expected_core_runtime_paths:
    fail("core runtime source inventory")


def require_package_blob(reference, label, executable=False):
    if not isinstance(reference, str) or not reference.startswith("./") or "\\" in reference:
        fail(f"{label} relative path")
    pure = pathlib.PurePosixPath(reference[2:])
    if not pure.parts or any(part in ("", ".", "..") for part in pure.parts):
        fail(f"{label} relative path")
    path = pure.as_posix()
    tagged_blob(path)
    if executable:
        entry = git("ls-tree", tag_ref, "--", path).decode("utf-8").strip()
        if not entry.startswith("100755 blob ") or not entry.endswith(f"\t{path}"):
            fail(f"{label} executable mode")


expected_scripts = {
    "start": "node ./bin/relu-ai-bridge.mjs serve",
    "init": "node ./bin/relu-ai-bridge.mjs init",
    "doctor": "node ./bin/relu-ai-bridge.mjs doctor",
    "archive-ledger": "node ./bin/relu-ai-bridge.mjs archive-ledger",
    "verify-skills": "node ./scripts/skills/manage-skills.mjs verify-source",
    "test": "node --test",
    "check": "node ./scripts/check-syntax.mjs && node ./scripts/skills/manage-skills.mjs verify-source && node --test",
}
if root_package.get("bin") != {"relu-ai-bridge": "./bin/relu-ai-bridge.mjs"}:
    fail("root package bin contract")
if root_package.get("scripts") != expected_scripts:
    fail("root package scripts contract")
for reference in root_package["bin"].values():
    require_package_blob(reference, "root package bin", executable=True)
for script_name, command in root_package["scripts"].items():
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        fail(f"root package script parse: {script_name}")
    for token in tokens:
        if token.startswith("./"):
            require_package_blob(token, f"root package script {script_name}")

expected_sdk_exports = {
    ".": {
        "types": "./relu-web-connector.d.ts",
        "default": "./relu-web-connector.js",
    }
}
if sdk_package.get("exports") != expected_sdk_exports:
    fail("SDK package exports contract")
for reference in expected_sdk_exports["."].values():
    require_package_blob(f"./sdk/{reference[2:]}", "SDK package export")

override_paths = {
    name
    for directory in ("", "sdk-dotnet/", "sdk-dotnet/src/", "sdk-dotnet/src/relu.ai.bridge.desktopconnector/")
    for name in (f"{directory}directory.build.props", f"{directory}directory.build.targets")
}
if not tagged_path_set.isdisjoint(override_paths):
    fail(".NET SDK Directory.Build override")
version_pattern = re.escape(core_version)
require_unique_regex(
    plugin_code,
    r"\b(?:const|let|var)[ \t]+PLUGIN_VERSION[ \t]*=",
    "Perfetto plugin version declaration count",
)
require_unique_regex(mcp_code, r"\bserverInfo\b[ \t]*:", "MCP serverInfo declaration count")
require_unique_regex(server_code, r"['\"]/health['\"]", "health route declaration count")
require_unique_regex(
    web_connector_code,
    r"\bthis\.connectorVersion[ \t]*=",
    "web connector version assignment count",
)
require_unique_regex(
    dotnet_embedded_code,
    r'^[ \t]*string[ \t]+version[ \t]*=',
    ".NET embedded service version declaration count",
    re.MULTILINE,
)
require_unique_regex(
    dotnet_stdio_code,
    r'^[ \t]*public const string StdioArgument = "--relu-mcp-stdio";[ \t]*$',
    ".NET embedded MCP stdio argument",
    re.MULTILINE,
)
require_unique_regex(
    dotnet_stdio_code,
    r'^[ \t]*private const string ProtocolVersion = "2025-06-18";[ \t]*$',
    ".NET embedded MCP protocol version",
    re.MULTILINE,
)
if '"2026-07-28"' in dotnet_stdio_code or '"server/discover"' in dotnet_stdio_code:
    fail(".NET embedded MCP obsolete discovery contract")
require_unique_regex(
    dotnet_stdio_code,
    r'if \(method == "initialize"\)',
    ".NET embedded MCP initialize lifecycle",
)
require_unique_regex(
    dotnet_stdio_code,
    r'if \(method == "notifications/initialized"\)',
    ".NET embedded MCP initialized notification",
)
require_unique_regex(
    dotnet_stdio_code,
    r'"tools/list" => Result\(id, ToolsListResult\(\)\)',
    ".NET embedded MCP tools/list route",
)
require_unique_regex(
    dotnet_stdio_code,
    r'"tools/call" => await HandleToolCallAsync\(',
    ".NET embedded MCP tools/call route",
)
require_unique_regex(
    dotnet_host_code,
    r"PipeOptions\.Asynchronous[ \t]*\|[ \t]*PipeOptions\.CurrentUserOnly",
    ".NET embedded same-user pipe",
)
require_unique_regex(
    dotnet_embedded_code,
    r'"relu-ai-bridge-pipe-v1\\0\{userIdentity\}\\0\{serviceId\}"',
    ".NET embedded per-user pipe namespace",
)
require_unique_regex(
    dotnet_embedded_code,
    r"WindowsIdentity\.GetCurrent\(\)",
    ".NET embedded Windows user SID binding",
)
require_unique_regex(
    dotnet_host_code,
    r"EmbeddedPipePeerVerifier\.VerifyClient\(pipe\);",
    ".NET embedded pipe client verification",
)
require_unique_regex(
    dotnet_host_code,
    r'OptionalString\(arguments, "operationId", 128, minimumLength: 8\)',
    ".NET embedded operationId bounds",
)
require_unique_regex(
    dotnet_peer_code,
    r"private static extern bool GetNamedPipeServerProcessId\(",
    ".NET embedded pipe server verification",
)
require_unique_regex(
    dotnet_registrar_code,
    r'\["mcp", "add", options\.ServerName, "--", executablePath, ReluMcpStdioEntryPoint\.StdioArgument\]',
    ".NET Codex user registration command",
)
require_unique_regex(
    dotnet_registrar_code,
    r'\["mcp", "add", "--scope", "user", options\.ServerName, "--", executablePath, ReluMcpStdioEntryPoint\.StdioArgument\]',
    ".NET Claude user registration command",
)
require_unique_regex(
    dotnet_registrar_code,
    r'"relu-ai-bridge-registrar-mutex-v1\\0\{userIdentity\}\\0\{serverName\}"',
    ".NET per-user registrar mutex namespace",
)
require_unique_regex(
    dotnet_registrar_code,
    r'return \$"Global\\\\Relu\.AI\.Bridge\.EndViewer\.McpRegistration\.\{Convert\.ToHexString\(digest\.AsSpan\(0, 12\)\)\}";',
    ".NET cross-session registrar mutex scope",
)
if 'return $"Local\\\\Relu.AI.Bridge.EndViewer.McpRegistration.' in dotnet_registrar_code:
    fail(".NET obsolete session-local registrar mutex")
require_unique_regex(
    dotnet_registrar_code,
    r'Path\.Combine\(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex\.exe"\)',
    ".NET official Codex install candidate",
)
if re.search(r"public[ \t]+string[ \t]+ExecutablePath\b", dotnet_registrar_code):
    fail(".NET registrar public executable path override")
require_unique_regex(
    web_connector_code,
    rf"^[ \t]*this\.connectorVersion = String\(options\.connectorVersion \?\? '{version_pattern}'\);[ \t]*$",
    "web connector default version",
    re.MULTILINE,
)
require_unique_regex(
    dotnet_embedded_code,
    rf'^[ \t]*string version = "{version_pattern}",[ \t]*$',
    ".NET embedded service default version",
    re.MULTILINE,
)

if not isinstance(skills_manifest, dict) or skills_manifest.get("schemaVersion") != 1:
    fail("Skill manifest schema")
if skills_manifest.get("suite") != "relu-ai-bridge-analysis-skills":
    fail("Skill manifest suite")
if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", skills_manifest.get("suiteVersion", "")) is None:
    fail("Skill suite version")
skills = skills_manifest.get("skills")
if not isinstance(skills, list) or not 1 <= len(skills) <= 32:
    fail("Skill manifest entries")
expected_skill_paths = {"skills/manifest.json"}
skill_names = set()
folded_paths = set()
for skill in skills:
    if not isinstance(skill, dict) or set(skill) != {"name", "directory", "files"}:
        fail("Skill manifest entry")
    name = skill.get("name", "")
    directory = skill.get("directory", "")
    if re.fullmatch(r"[a-z0-9-]{1,63}", name) is None or directory != name or name in skill_names:
        fail("Skill name/directory")
    skill_names.add(name)
    records = skill.get("files")
    if not isinstance(records, list) or not 1 <= len(records) <= 256:
        fail("Skill file inventory")
    has_entrypoint = False
    for record in records:
        if not isinstance(record, dict) or set(record) != {"path", "sha256", "bytes"}:
            fail("Skill file record")
        relative = record.get("path", "")
        parts = relative.split("/") if isinstance(relative, str) else []
        if (not relative or len(relative) > 240 or "\\" in relative or relative.startswith("/")
                or any(part in ("", ".", "..", ".relu-ai-bridge-install.json") for part in parts)):
            fail("Skill file path")
        full_path = f"skills/{directory}/{relative}"
        folded = full_path.lower()
        if folded in folded_paths:
            fail("Skill file path collision")
        folded_paths.add(folded)
        expected_skill_paths.add(full_path)
        content = tagged_blob(full_path)
        if (not isinstance(record.get("bytes"), int) or record["bytes"] != len(content)
                or not 1 <= record["bytes"] <= 4 * 1024 * 1024):
            fail("Skill file byte length")
        if not isinstance(record.get("sha256"), str) or hashlib.sha256(content).hexdigest() != record["sha256"]:
            fail("Skill file digest")
        if relative == "SKILL.md":
            has_entrypoint = True
    if not has_entrypoint:
        fail("Skill entrypoint")
actual_skill_paths = set(git("ls-tree", "-r", "--name-only", tag_ref, "--", "skills").decode("utf-8").splitlines())
if actual_skill_paths != expected_skill_paths:
    fail("Skill tree inventory")
if not isinstance(extension, dict) or extension.get("name") != "RELU AI Bridge Companion":
    fail("Chrome Companion name")
if extension.get("version") != core_version:
    fail("Chrome Companion version")

version_pattern = re.escape(core_version)
require_unique_regex(
    plugin_code,
    r"^[ \t]*const PLUGIN_ID = 'io\.company\.RELUPerfettoBridge';[ \t]*$",
    "Perfetto plugin id",
    re.MULTILINE,
)
require_unique_regex(
    plugin_code,
    rf"^[ \t]*const PLUGIN_VERSION = '{version_pattern}';[ \t]*$",
    "Perfetto plugin version",
    re.MULTILINE,
)
require_unique_regex(
    plugin_code,
    r"^[ \t]*const COMMAND_SOURCE = 'RELU AI Bridge · Perfetto';[ \t]*$",
    "Perfetto plugin branding",
    re.MULTILINE,
)
require_unique_regex(
    plugin_code,
    r"^[ \t]*static readonly id = PLUGIN_ID;[ \t]*$",
    "Perfetto plugin id binding",
    re.MULTILINE,
)
require_unique_regex(
    plugin_code,
    r"^[ \t]*pluginVersion: PLUGIN_VERSION,[ \t]*$",
    "Perfetto plugin version binding",
    re.MULTILINE,
)
require_unique_regex(
    mcp_code,
    rf"serverInfo:\s*\{{\s*name:\s*'relu-ai-bridge',\s*version:\s*'{version_pattern}'\s*\}}",
    "MCP serverInfo",
)
require_unique_regex(
    server_code,
    rf"if \(requestUrl\.pathname === '/health'\) \{{\s*"
    rf"return sendJson\(response, 200, \{{\s*ok: true,\s*"
    rf"name:\s*'relu-ai-bridge',\s*version:\s*'{version_pattern}',",
    "health identity",
)
PY

git -c core.quotePath=true -C "$verify_repo" \
  ls-tree -r "$release_tag" > "$verify_root/source-inventory.actual"
cmp -s "$verify_root/source-inventory.actual" "$release_dir/source-inventory.txt" || \
  die "source-inventory.txt가 bundle tree와 다릅니다"
git -c log.showSignature=false -C "$verify_repo" log --topo-order \
  --format='%H%x09%P%x09%aI%x09%an <%ae>%x09%cn <%ce>%x09%s' "$release_tag" \
  > "$verify_root/history-inventory.actual"
cmp -s "$verify_root/history-inventory.actual" "$release_dir/history-inventory.txt" || \
  die "history-inventory.txt가 bundle history와 다릅니다"
git -C "$verify_repo" cat-file -p "$tag_ref" > "$verify_root/tag-metadata.actual"
cmp -s "$verify_root/tag-metadata.actual" "$release_dir/tag-metadata.txt" || \
  die "tag-metadata.txt가 bundle tag object와 다릅니다"
git -c core.quotePath=true -C "$verify_repo" ls-tree -r "$release_tag" -- \
  package.json sdk/package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock \
  requirements.txt requirements.lock pyproject.toml uv.lock Cargo.toml Cargo.lock \
  sdk-dotnet/Relu.AI.Bridge.DesktopConnector.sln \
  sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj \
  sdk-dotnet/tests/Relu.AI.Bridge.DesktopConnector.Tests/Relu.AI.Bridge.DesktopConnector.Tests.csproj \
  examples/wpf-android-log-viewer/WpfAndroidLogViewer.Integration.csproj \
  skills/manifest.json \
  > "$verify_root/dependency-manifest.actual"
cmp -s "$verify_root/dependency-manifest.actual" "$release_dir/dependency-manifest.txt" || \
  die "dependency-manifest.txt가 bundle dependency tree와 다릅니다"

actual_core_blob=$(git -C "$verify_repo" rev-parse "$release_tag:$core_contract_path")
actual_connector_blob=$(git -C "$verify_repo" rev-parse "$release_tag:$connector_contract_path")
actual_core_bin_tree=$(git -C "$verify_repo" rev-parse "$release_tag:bin")
actual_core_src_tree=$(git -C "$verify_repo" rev-parse "$release_tag:src")
actual_core_web_tree=$(git -C "$verify_repo" rev-parse "$release_tag:web")
actual_plugin_tree=$(git -C "$verify_repo" rev-parse \
  "$release_tag:$(compat_value integration.source_plugin_path)")
actual_adapter_tree=$(git -C "$verify_repo" rev-parse \
  "$release_tag:$(compat_value integration.source_adapter_path)")
actual_embedded_sdk_tree=$(git -C "$verify_repo" rev-parse \
  "$release_tag:sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector")
verified_package_identity=$(git -C "$verify_repo" show "$release_tag:package.json" | \
  python3 -c 'import json,sys; value=json.load(sys.stdin); print(value.get("name", "")); print(value.get("version", ""))')
[ "$(printf '%s\n' "$verified_package_identity" | sed -n '1p')" = relu-ai-bridge ] || \
  die "bundle package name 불일치"
[ "$(printf '%s\n' "$verified_package_identity" | sed -n '2p')" = "$manifest_core_version" ] || \
  die "bundle package version과 RELU core version이 다릅니다"
[ "$actual_core_blob" = "$manifest_core_blob" ] || die "manifest core contract blob 불일치"
[ "$actual_connector_blob" = "$manifest_connector_blob" ] || \
  die "manifest connector contract blob 불일치"
[ "$actual_core_bin_tree" = "$manifest_core_bin_tree" ] || die "manifest core bin tree 불일치"
[ "$actual_core_src_tree" = "$manifest_core_src_tree" ] || die "manifest core src tree 불일치"
[ "$actual_core_web_tree" = "$manifest_core_web_tree" ] || die "manifest core web tree 불일치"
[ "$actual_plugin_tree" = "$manifest_plugin_tree" ] || die "manifest plugin tree 불일치"
[ "$actual_adapter_tree" = "$manifest_adapter_tree" ] || die "manifest adapter tree 불일치"
[ "$actual_embedded_sdk_tree" = "$manifest_embedded_sdk_tree" ] || \
  die "manifest embedded SDK tree 불일치"
[ "$actual_core_blob" = "$(git hash-object "$RELU_COMPAT_FILE")" ] || \
  die "bundle core contract가 현재 검증 도구 contract와 다릅니다"
[ "$actual_connector_blob" = "$(git hash-object "$PERFETTO_COMPAT_FILE")" ] || \
  die "bundle Perfetto connector contract가 현재 검증 도구 contract와 다릅니다"

# 검증 중 inbound 디렉터리가 교체되는 TOCTOU를 탐지한다. import에 전달하는 것은
# 어차피 검역 repo에서 새로 만든 bundle이지만 검증 결과 자체도 같은 snapshot이어야 한다.
[ "$(sha256_file "$release_dir/SHA256SUMS")" = "$initial_sums_sha" ] || \
  die "검증 중 SHA256SUMS가 변경되었습니다"
verify_sha256_sums "$release_dir"
[ "$(sha256_file "$release_dir/$bundle_name")" = "$manifest_bundle_sha" ] || \
  die "검증 중 inbound bundle이 변경되었습니다"

if [ -n "$sanitized_bundle" ]; then
  assert_path_absent "$sanitized_bundle"
  sanitized_parent=$(dirname -- "$sanitized_bundle")
  [ -d "$sanitized_parent" ] || die "sanitized bundle 상위 디렉터리가 없습니다"
  sanitized_parent=$(canonical_existing_dir "$sanitized_parent")
  case "$sanitized_parent/" in
    "$release_dir/"|"$release_dir/"*)
      die "sanitized bundle을 inbound release 디렉터리 안에 만들 수 없습니다"
      ;;
  esac
  sanitized_bundle="$sanitized_parent/$(basename -- "$sanitized_bundle")"
  assert_destination_outside_project_root "$sanitized_bundle"
  assert_path_absent "$sanitized_bundle"
  sanitized_stage=$(mktemp -d "$sanitized_parent/.relu-ai-bridge-sanitized.XXXXXX")
  git -C "$verify_repo" bundle create "$sanitized_stage/release.bundle" "$tag_ref"
  git -C "$verify_repo" bundle verify "$sanitized_stage/release.bundle" >/dev/null
  sanitized_heads=$(git bundle list-heads "$sanitized_stage/release.bundle")
  [ "$sanitized_heads" = "$tag_object $tag_ref" ] || \
    die "sanitized bundle head 생성 오류"
  sanitized_size=$(wc -c < "$sanitized_stage/release.bundle" | tr -d '[:space:]')
  [ "$sanitized_size" -le "$MAX_RELEASE_BUNDLE_BYTES" ] || \
    die "sanitized bundle 크기 상한 초과"
  mv -- "$sanitized_stage/release.bundle" "$sanitized_bundle"
  rmdir -- "$sanitized_stage"
  sanitized_stage=
  info "검역된 exact-tag bundle 생성: $sanitized_bundle"
fi

info "RELU AI Bridge 릴리스 검증 통과: $release_tag ($release_commit)"
