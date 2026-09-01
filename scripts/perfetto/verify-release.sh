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
        "signed_tag_verified",
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
if not isinstance(release.get("signed_tag_verified"), bool):
    raise SystemExit("signed tag 검증 상태 형식 오류")
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
if connector.get("manifest_path") != "compat/connectors/perfetto-v57.2.json":
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
exact_keys(data["source_trees"], ["connectors"], "source trees")
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
    data["source_trees"]["connectors"]["perfetto"].get("plugin", ""),
    data["source_trees"]["connectors"]["perfetto"].get("adapter", ""),
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
print(data["source_trees"]["connectors"]["perfetto"]["plugin"])
print(data["source_trees"]["connectors"]["perfetto"]["adapter"])
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
manifest_plugin_tree=$(printf '%s\n' "$manifest_values" | sed -n '14p')
manifest_adapter_tree=$(printf '%s\n' "$manifest_values" | sed -n '15p')

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
import json
import pathlib
import re
import subprocess
import sys

repository = pathlib.Path(sys.argv[1])
tag_ref = sys.argv[2]
core_version = sys.argv[3]
max_contract_blob_bytes = 2 * 1024 * 1024


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


def require_unique_regex(source, pattern, label, flags=0):
    if len(list(re.finditer(pattern, source, flags))) != 1:
        fail(label)


root_package = tagged_json("package.json")
sdk_package = tagged_json("sdk/package.json")
extension = tagged_json("extension/manifest.json")
plugin_source = tagged_text("plugin/io.company.RELUPerfettoBridge/index.ts")
mcp_source = tagged_text("src/mcp.mjs")
server_source = tagged_text("src/server.mjs")
plugin_code = strip_javascript_comments(plugin_source, "Perfetto plugin")
mcp_code = strip_javascript_comments(mcp_source, "MCP server")
server_code = strip_javascript_comments(server_source, "health server")

if not isinstance(root_package, dict) or root_package.get("name") != "relu-ai-bridge":
    fail("root package name")
if root_package.get("version") != core_version:
    fail("root package version")
if not isinstance(sdk_package, dict) or sdk_package.get("name") != "@company/relu-ai-connector":
    fail("SDK package name")
if sdk_package.get("version") != core_version:
    fail("SDK package version")
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
  package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock \
  requirements.txt requirements.lock pyproject.toml uv.lock Cargo.toml Cargo.lock \
  > "$verify_root/dependency-manifest.actual"
cmp -s "$verify_root/dependency-manifest.actual" "$release_dir/dependency-manifest.txt" || \
  die "dependency-manifest.txt가 bundle dependency tree와 다릅니다"

actual_core_blob=$(git -C "$verify_repo" rev-parse "$release_tag:$core_contract_path")
actual_connector_blob=$(git -C "$verify_repo" rev-parse "$release_tag:$connector_contract_path")
actual_plugin_tree=$(git -C "$verify_repo" rev-parse \
  "$release_tag:$(compat_value integration.source_plugin_path)")
actual_adapter_tree=$(git -C "$verify_repo" rev-parse \
  "$release_tag:$(compat_value integration.source_adapter_path)")
verified_package_identity=$(git -C "$verify_repo" show "$release_tag:package.json" | \
  python3 -c 'import json,sys; value=json.load(sys.stdin); print(value.get("name", "")); print(value.get("version", ""))')
[ "$(printf '%s\n' "$verified_package_identity" | sed -n '1p')" = relu-ai-bridge ] || \
  die "bundle package name 불일치"
[ "$(printf '%s\n' "$verified_package_identity" | sed -n '2p')" = "$manifest_core_version" ] || \
  die "bundle package version과 RELU core version이 다릅니다"
[ "$actual_core_blob" = "$manifest_core_blob" ] || die "manifest core contract blob 불일치"
[ "$actual_connector_blob" = "$manifest_connector_blob" ] || \
  die "manifest connector contract blob 불일치"
[ "$actual_plugin_tree" = "$manifest_plugin_tree" ] || die "manifest plugin tree 불일치"
[ "$actual_adapter_tree" = "$manifest_adapter_tree" ] || die "manifest adapter tree 불일치"
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
