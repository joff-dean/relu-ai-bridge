#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
사용법:
  scripts/perfetto/verify-integration.sh [--target upstream|company]
    [--expected-head SHA] [--company-adapter-dir DIR]
    [--expected-company-adapter-sha256 SHA256] [--fingerprint]
    PERFETTO_DIR

upstream은 manifest의 exact Perfetto v58.2 peeled commit과 raw tag object를 강제한다.
company는 사내에서 고정한 40자리 --expected-head가 반드시 필요하다.
company adapter가 적용된 checkout은 승인 원본 디렉터리와 외부 승인 SHA-256도 필수다.
--fingerprint는 검증된 build input fingerprint만 출력한다.
EOF
}

target_kind=upstream
expected_head=
company_adapter_argument=
expected_company_adapter_sha256=
fingerprint_only=0
perfetto_argument=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || die "--target 값이 필요합니다"; target_kind=$2; shift 2 ;;
    --expected-head) [ "$#" -ge 2 ] || die "--expected-head 값이 필요합니다"; expected_head=$2; shift 2 ;;
    --company-adapter-dir)
      [ "$#" -ge 2 ] || die "--company-adapter-dir 값이 필요합니다"
      company_adapter_argument=$2
      shift 2
      ;;
    --expected-company-adapter-sha256)
      [ "$#" -ge 2 ] || die "--expected-company-adapter-sha256 값이 필요합니다"
      expected_company_adapter_sha256=$2
      shift 2
      ;;
    --fingerprint) fingerprint_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "알 수 없는 옵션: $1" ;;
    *) [ -z "$perfetto_argument" ] || die "PERFETTO_DIR은 하나만 지정하십시오"; perfetto_argument=$1; shift ;;
  esac
done
[ -n "$perfetto_argument" ] || { usage >&2; exit 2; }
case "$target_kind" in upstream|company) ;; *) die "--target은 upstream 또는 company여야 합니다" ;; esac
require_command git
require_command python3
assert_compatibility_alignment
perfetto_dir=$(canonical_existing_dir "$perfetto_argument")
assert_git_worktree_root "$perfetto_dir"
assert_git_metadata_outside_project_root "$perfetto_dir"

if [ "$target_kind" = upstream ]; then
  [ -z "$expected_head" ] || die "upstream 대상에는 --expected-head를 사용하지 않습니다"
  assert_exact_head "$perfetto_dir" "$(compat_value public_baseline.commit_sha)"
  upstream_tag=$(compat_value public_baseline.release)
  [ "$(git -C "$perfetto_dir" rev-parse "refs/tags/$upstream_tag" 2>/dev/null || true)" = \
    "$(compat_value public_baseline.tag_object_sha)" ] || die "Perfetto raw tag object SHA 불일치"
  [ "$(git -C "$perfetto_dir" rev-parse "refs/tags/$upstream_tag^{}" 2>/dev/null || true)" = \
    "$(compat_value public_baseline.commit_sha)" ] || die "Perfetto peeled tag commit SHA 불일치"
else
  printf '%s\n' "$expected_head" | grep -Eq '^[0-9a-f]{40}$' || \
    die "company 대상에는 내부에서 확인한 40자리 --expected-head가 필요합니다"
  assert_exact_head "$perfetto_dir" "$expected_head"
fi
verified_head=$(git -C "$perfetto_dir" rev-parse HEAD)

company_adapter_dir=
if [ -n "$company_adapter_argument" ]; then
  [ "$target_kind" = company ] || die "--company-adapter-dir은 company 대상에만 사용합니다"
  company_adapter_dir=$(canonical_existing_dir "$company_adapter_argument")
  assert_disjoint_trees "$PERFETTO_PROJECT_ROOT" "$company_adapter_dir"
  assert_disjoint_trees "$perfetto_dir" "$company_adapter_dir"
  printf '%s\n' "$expected_company_adapter_sha256" | grep -Eq '^[0-9a-f]{64}$' || \
    die "--company-adapter-dir에는 외부 승인 64자리 --expected-company-adapter-sha256가 필요합니다"
elif [ -n "$expected_company_adapter_sha256" ]; then
  die "--expected-company-adapter-sha256에는 --company-adapter-dir이 필요합니다"
fi

plugin_rel=$(compat_value integration.target_plugin_path)
adapter_rel=$(compat_value integration.target_adapter_path)
default_plugins_rel=$(compat_value integration.default_plugins_file)
plugin_id=$(compat_value integration.plugin_id)
plugin_source_rel=$(compat_value integration.source_plugin_path)
adapter_source_rel=$(compat_value integration.source_adapter_path)

[ -f "$perfetto_dir/$plugin_rel/index.ts" ] || die "통합 plugin index.ts가 없습니다"
[ -f "$perfetto_dir/$adapter_rel/protocol.ts" ] || die "통합 adapter protocol.ts가 없습니다"
[ -d "$perfetto_dir/$adapter_rel/v58" ] || die "통합 v58 adapter가 없습니다"
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

# HEAD SHA만으로는 working tree를 고정할 수 없다. tracked/untracked 변경은 RELU가
# 관리하는 두 overlay와 exact default_plugins 한 줄만 허용하고, ignored 항목도
# dependency/build output allowlist 또는 동일한 overlay inventory 밖이면 거부한다.
# Copy overlay는 현재 RELU source와 byte/mode inventory가 같아야 하며 symlink 개발
# overlay는 각 top-level link가 정확한 source entry를 가리켜야 한다.
verification_output=$(python3 - "$perfetto_dir" "$PERFETTO_PROJECT_ROOT" "$target_kind" \
  "$expected_head" "$verified_head" "$company_adapter_dir" \
  "$expected_company_adapter_sha256" "$plugin_rel" "$adapter_rel" \
  "$default_plugins_rel" "$plugin_source_rel" "$adapter_source_rel" "$plugin_id" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import unicodedata

(
    repository_arg,
    relu_root_arg,
    target_kind,
    expected_head,
    verified_head,
    company_adapter_arg,
    expected_company_adapter_sha256,
    plugin_relative,
    adapter_relative,
    default_plugins_relative,
    plugin_source_relative,
    adapter_source_relative,
    plugin_id,
) = sys.argv[1:]
repository = pathlib.Path(repository_arg)
relu_root = pathlib.Path(relu_root_arg)
company_adapter = pathlib.Path(company_adapter_arg) if company_adapter_arg else None


def fail(message):
    raise SystemExit(f"Perfetto integration working tree contract 불일치: {message}")


def run_git(root, *arguments):
    completed = subprocess.run(
        ["git", "-C", str(root), *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        fail(f"git inventory read: {' '.join(arguments[:2])}")
    return completed.stdout


def git_bytes(*arguments):
    return run_git(repository, *arguments)


def git_text(root, *arguments):
    try:
        return run_git(root, *arguments).decode("utf-8")
    except UnicodeDecodeError:
        fail("git returned non-UTF-8 text")


def nul_paths(*arguments):
    raw = git_bytes(*arguments)
    try:
        return [item.decode("utf-8") for item in raw.split(b"\0") if item]
    except UnicodeDecodeError:
        fail("non-UTF-8 path")


def normalized_key(path):
    return unicodedata.normalize("NFC", path).casefold()


def ensure_unique_paths(paths, label):
    seen = {}
    for path in paths:
        key = normalized_key(path)
        if key in seen and seen[key] != path:
            fail(f"{label} case/Unicode path collision: {seen[key]} / {path}")
        seen[key] = path


def read_text_file(path, label):
    try:
        if path.is_symlink() or not path.is_file():
            fail(f"{label} is not a regular file")
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        fail(f"{label} is not UTF-8")


def tree_inventory(root, label):
    if root.is_symlink() or not root.is_dir():
        fail(f"{label} root is not a real directory")
    result = {}
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = pathlib.Path(current)
        for directory in list(directories):
            candidate = current_path / directory
            if candidate.is_symlink():
                fail(f"{label} contains directory symlink: {candidate.relative_to(root).as_posix()}")
        for filename in files:
            candidate = current_path / filename
            relative = candidate.relative_to(root).as_posix()
            if candidate.is_symlink():
                fail(f"{label} contains file symlink: {relative}")
            metadata = candidate.stat()
            if not stat.S_ISREG(metadata.st_mode):
                fail(f"{label} contains non-regular file: {relative}")
            result[relative] = (
                hashlib.sha256(candidate.read_bytes()).hexdigest(),
                metadata.st_size,
                1 if stat.S_IMODE(metadata.st_mode) & 0o111 else 0,
            )
    ensure_unique_paths(result, label)
    return result


def committed_tree_inventory(root, commit, relative_root, label):
    raw = run_git(root, "ls-tree", "-rz", commit, "--", relative_root)
    result = {}
    prefix = relative_root.rstrip("/") + "/"
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, path_bytes = record.split(b"\t", 1)
            mode, object_type, object_id = metadata.decode("ascii").split(" ")
            path = path_bytes.decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            fail(f"{label} committed tree parse")
        if object_type != "blob" or mode not in {"100644", "100755"}:
            fail(f"{label} committed tree has unsupported entry: {path}")
        if not path.startswith(prefix):
            fail(f"{label} committed path escaped root: {path}")
        relative = path[len(prefix):]
        content = run_git(root, "cat-file", "blob", object_id)
        result[relative] = (
            hashlib.sha256(content).hexdigest(),
            len(content),
            1 if mode == "100755" else 0,
        )
    if not result:
        fail(f"{label} committed tree is empty")
    ensure_unique_paths(result, f"{label} committed tree")
    return result


def marker_mode(target, label):
    marker = target / ".relu-ai-bridge-managed"
    value = read_text_file(marker, f"{label} marker")
    lines = value.splitlines()
    if len(lines) != 3 or lines[:2] != [
        "managed-by=relu-ai-bridge",
        "connector=perfetto",
    ] or lines[2] not in {"mode=copy", "mode=symlink"} or not value.endswith("\n"):
        fail(f"{label} marker")
    return lines[2].split("=", 1)[1]


def verify_symlink_overlay(source, target, label):
    source_inventory = tree_inventory(source, f"{label} source")
    if target.is_symlink() or not target.is_dir():
        fail(f"{label} target root is not a real directory")
    source_names = sorted(entry.name for entry in source.iterdir())
    target_names = sorted(
        entry.name for entry in target.iterdir()
        if entry.name != ".relu-ai-bridge-managed"
    )
    ensure_unique_paths(source_names, f"{label} source")
    ensure_unique_paths(target_names, f"{label} target")
    if source_names != target_names:
        fail(f"{label} symlink inventory")
    for name in source_names:
        source_entry = source / name
        target_entry = target / name
        if not target_entry.is_symlink():
            fail(f"{label} symlink entry is not a link: {name}")
        if target_entry.resolve(strict=True) != source_entry.resolve(strict=True):
            fail(f"{label} symlink target mismatch: {name}")
    return {
        "source": source_inventory,
        "links": {
            name: str((target / name).resolve(strict=True)) for name in source_names
        },
    }


def parse_company_adapter(source_inventory):
    if company_adapter is None:
        fail("company adapter source requires --company-adapter-dir")
    manifest_path = company_adapter / "COMPANY_ADAPTER.json"
    manifest_text = read_text_file(manifest_path, "company adapter manifest")

    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("company adapter manifest duplicate key")
            result[key] = value
        return result

    try:
        manifest = json.loads(manifest_text, object_pairs_hook=reject_duplicates)
    except (json.JSONDecodeError, TypeError):
        fail("company adapter manifest JSON")
    if not isinstance(manifest, dict) or set(manifest) != {
        "schema_version", "company_perfetto_commit", "base_adapter"
    }:
        fail("company adapter manifest fields")
    if manifest != {
        "schema_version": 1,
        "company_perfetto_commit": expected_head,
        "base_adapter": "v58",
    }:
        fail("company adapter manifest contract/HEAD")
    payload = dict(source_inventory)
    payload.pop("COMPANY_ADAPTER.json", None)
    if "index.ts" not in payload:
        fail("company adapter source index.ts")
    for path in payload:
        pure = pathlib.PurePosixPath(path)
        folded_parts = {part.casefold() for part in pure.parts}
        if folded_parts.intersection({".git", "node_modules"}) or any(
            part.casefold().startswith(".env") for part in pure.parts
        ) or pure.suffix.casefold() in {
            ".pftrace", ".perfetto-trace", ".trace", ".pem", ".p12", ".pfx", ".key"
        }:
            fail(f"company adapter forbidden path: {path}")
    payload_digest = hashlib.sha256(json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    if payload_digest != expected_company_adapter_sha256:
        fail("company adapter source digest differs from external approval")
    return manifest, payload, payload_digest


def verify_copy_overlay(
    source,
    target,
    source_relative,
    label,
    allow_company_adapter=False,
):
    committed_inventory = committed_tree_inventory(
        relu_root, relu_head, source_relative, f"{label} source"
    )
    source_inventory = tree_inventory(source, f"{label} source")
    if source_inventory != committed_inventory:
        fail(f"{label} source differs from RELU committed HEAD tree")
    target_inventory = tree_inventory(target, f"{label} target")
    target_inventory.pop(".relu-ai-bridge-managed", None)
    company_marker_path = "v58/.company-adapter-applied"
    has_company_adapter = company_marker_path in target_inventory
    if not allow_company_adapter or not has_company_adapter:
        if company_adapter is not None and allow_company_adapter:
            fail("--company-adapter-dir was supplied but no company adapter is installed")
        if committed_inventory != target_inventory:
            fail(f"{label} copy inventory")
        return {"committed_source": committed_inventory, "target": target_inventory}

    company_prefix = "v58/"
    source_generic = {
        path: value for path, value in committed_inventory.items()
        if not path.startswith(company_prefix)
    }
    target_generic = {
        path: value for path, value in target_inventory.items()
        if not path.startswith(company_prefix)
    }
    if source_generic != target_generic:
        fail("company adapter changed generic adapter files")
    company_root = target / "v58"
    marker = company_root / ".company-adapter-applied"
    marker_value = read_text_file(marker, "company adapter marker")
    expected_marker = (
        "managed-by=company-internal-adapter\n"
        f"company-perfetto-commit={expected_head}\n"
    )
    if target_kind != "company" or marker_value != expected_marker:
        fail("company adapter marker/HEAD")
    if company_adapter is None:
        fail("company adapter source requires --company-adapter-dir")
    company_source_inventory = tree_inventory(company_adapter, "company adapter source")
    company_manifest, company_payload, company_digest = parse_company_adapter(
        company_source_inventory
    )
    target_company = {
        path[len(company_prefix):]: value
        for path, value in target_inventory.items()
        if path.startswith(company_prefix) and path != company_marker_path
    }
    if company_payload != target_company:
        fail("company adapter target differs from trusted source")
    return {
        "committed_generic_source": source_generic,
        "target_generic": target_generic,
        "company_manifest": company_manifest,
        "company_approved_sha256": company_digest,
        "company_source": company_source_inventory,
        "company_target": target_company,
    }


relu_head = git_text(relu_root, "rev-parse", "HEAD").strip()
if len(relu_head) != 40 or any(character not in "0123456789abcdef" for character in relu_head):
    fail("RELU HEAD is not an exact SHA-1")
plugin_source = relu_root / plugin_source_relative
adapter_source = relu_root / adapter_source_relative
plugin_target = repository / plugin_relative
adapter_target = repository / adapter_relative


def collect_overlay_evidence():
    plugin_mode = marker_mode(plugin_target, "plugin")
    adapter_mode = marker_mode(adapter_target, "adapter")
    if target_kind == "company" and (plugin_mode != "copy" or adapter_mode != "copy"):
        fail("company target requires copy overlays")
    if plugin_mode == "copy":
        plugin_evidence = verify_copy_overlay(
            plugin_source, plugin_target, plugin_source_relative, "plugin"
        )
    else:
        plugin_evidence = verify_symlink_overlay(plugin_source, plugin_target, "plugin")
    if adapter_mode == "copy":
        adapter_evidence = verify_copy_overlay(
            adapter_source,
            adapter_target,
            adapter_source_relative,
            "adapter",
            allow_company_adapter=(target_kind == "company"),
        )
    else:
        if company_adapter is not None:
            fail("company adapter source cannot be used with a symlink overlay")
        adapter_evidence = verify_symlink_overlay(adapter_source, adapter_target, "adapter")
    return {
        "plugin_mode": plugin_mode,
        "adapter_mode": adapter_mode,
        "plugin": plugin_evidence,
        "adapter": adapter_evidence,
    }


overlay_evidence = collect_overlay_evidence()

default_path = repository / default_plugins_relative
actual_default = read_text_file(default_path, "default_plugins")
try:
    base_default = git_bytes("show", f"{verified_head}:{default_plugins_relative}").decode("utf-8")
except UnicodeDecodeError:
    fail("verified HEAD default_plugins is not UTF-8")
literal = f"  '{plugin_id}',"
anchor = "  'dev.perfetto.VideoFrames',"
base_count = base_default.splitlines().count(literal)
if base_count == 1:
    expected_default = base_default
elif base_count == 0 and base_default.splitlines().count(anchor) == 1:
    expected_default = base_default.replace(anchor, f"{anchor}\n{literal}", 1)
else:
    fail("verified HEAD default_plugins anchor/plugin count")
if actual_default != expected_default:
    fail("default_plugins is not the exact one-line RELU integration")


def is_overlay_path(path):
    return (
        path == default_plugins_relative
        or path == plugin_relative
        or path.startswith(plugin_relative + "/")
        or path == adapter_relative
        or path.startswith(adapter_relative + "/")
    )


def allowed_ignored_generated(path):
    parts = pathlib.PurePosixPath(path).parts
    if not parts:
        return False
    if path == "ui/src/gen":
        generated_link = repository / path
        expected_generated = repository / "out/ui/ui/tsc/gen"
        try:
            return generated_link.is_symlink() and (
                generated_link.resolve(strict=True)
                == expected_generated.resolve(strict=True)
            )
        except (OSError, RuntimeError):
            return False
    first = parts[0]
    if first in {".venv", "buildtools"}:
        return True
    if first == "out":
        return True
    if len(parts) >= 2 and parts[:2] in {
        ("ui", "node_modules"),
        ("ui", "out"),
        ("ui", "dist"),
        ("test", "data"),
    }:
        return True
    if len(parts) >= 2 and parts[0] == "third_party" and parts[1] in {
        "clang-format", "gn", "ninja", "pnpm"
    }:
        return True
    if "__pycache__" in parts and pathlib.PurePosixPath(path).suffix == ".pyc":
        return True
    return False


def validate_git_state():
    if git_bytes("ls-files", "--unmerged", "-z"):
        fail("unmerged index entries")
    for record in git_bytes("ls-files", "-v", "-z").split(b"\0"):
        if not record:
            continue
        try:
            tag = record[:1].decode("ascii")
            path = record[2:].decode("utf-8")
        except UnicodeDecodeError:
            fail("non-UTF-8 or invalid index path")
        if tag == "S" or tag.islower():
            fail(f"skip-worktree/assume-unchanged index entry: {path}")

    staged = nul_paths(
        "diff", "--cached", "--no-renames", "--name-only", "-z", verified_head, "--"
    )
    if staged:
        fail(f"staged drift is not allowed: {staged[0]}")
    tracked = nul_paths("diff", "--no-renames", "--name-only", "-z", "--")
    untracked = nul_paths("ls-files", "--others", "--exclude-standard", "-z")
    tracked_all = nul_paths("ls-files", "-z")
    ensure_unique_paths(tracked_all + untracked, "working tree")
    for path in tracked:
        if not is_overlay_path(path):
            fail(f"unexpected tracked drift: {path}")
    for path in untracked:
        if not is_overlay_path(path):
            fail(f"unexpected untracked drift: {path}")

    ignored = nul_paths("ls-files", "--others", "--ignored", "--exclude-standard", "-z")
    ensure_unique_paths(ignored, "ignored working tree")
    for path in ignored:
        # Overlay inventory was already checked recursively, so an ignored overlay
        # item can only be accepted when it is part of that exact inventory.
        if is_overlay_path(path):
            continue
        if not allowed_ignored_generated(path):
            fail(f"unexpected ignored drift: {path}")


validate_git_state()
if git_text(repository, "rev-parse", "HEAD").strip() != verified_head:
    fail("Perfetto HEAD changed during verification")
if git_text(relu_root, "rev-parse", "HEAD").strip() != relu_head:
    fail("RELU HEAD changed during verification")
if actual_default != read_text_file(default_path, "default_plugins"):
    fail("default_plugins changed during verification")
if overlay_evidence != collect_overlay_evidence():
    fail("overlay/source changed during verification")
validate_git_state()
if git_text(repository, "rev-parse", "HEAD").strip() != verified_head:
    fail("Perfetto HEAD changed during final verification")
if git_text(relu_root, "rev-parse", "HEAD").strip() != relu_head:
    fail("RELU HEAD changed during final verification")
if actual_default != read_text_file(default_path, "default_plugins"):
    fail("default_plugins changed during final verification")

fingerprint_payload = {
    "schema": 1,
    "target": target_kind,
    "perfetto_head": verified_head,
    "relu_head": relu_head,
    "default_plugins_sha256": hashlib.sha256(actual_default.encode("utf-8")).hexdigest(),
    "overlay": overlay_evidence,
}
print(hashlib.sha256(
    json.dumps(
        fingerprint_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
).hexdigest())
PY
)

if [ "$fingerprint_only" -eq 1 ]; then
  printf '%s\n' "$verification_output"
  exit 0
fi

info "통합 구조 검증 통과"
info "target: $target_kind (HEAD $verified_head)"
info "plugin: $plugin_rel"
info "adapter: $adapter_rel (contract v58)"
info "build input fingerprint: $verification_output"
