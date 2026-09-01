#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

case "${1:-}" in -h|--help)
  printf '%s\n' '사용법: scripts/perfetto/smoke-test.sh [PERFETTO_V57_2_DIR]'
  exit 0
;; esac
[ "$#" -le 1 ] || die "사용법: scripts/perfetto/smoke-test.sh [PERFETTO_V57_2_DIR]"
require_command git
require_command python3
assert_compatibility_alignment

for script in "$SCRIPT_DIR"/*.sh; do
  bash -n "$script"
done
assert_source_layout

python3 - "$RELU_COMPAT_FILE" "$PERFETTO_COMPAT_FILE" \
  "$PERFETTO_PROJECT_ROOT/package.json" \
  "$PERFETTO_PROJECT_ROOT/sdk/package.json" \
  "$PERFETTO_PROJECT_ROOT/extension/manifest.json" \
  "$PERFETTO_PROJECT_ROOT/plugin/io.company.RELUPerfettoBridge/index.ts" \
  "$PERFETTO_PROJECT_ROOT/src/mcp.mjs" \
  "$PERFETTO_PROJECT_ROOT/src/server.mjs" <<'PY'
import json
import pathlib
import re
import sys

relu = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
data = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
package = json.loads(pathlib.Path(sys.argv[3]).read_text(encoding="utf-8"))
sdk = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))
extension = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))
plugin_source = pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")
mcp_source = pathlib.Path(sys.argv[7]).read_text(encoding="utf-8")
server_source = pathlib.Path(sys.argv[8]).read_text(encoding="utf-8")

def require(condition, label):
    if not condition:
        raise SystemExit(f"version/branding contract 불일치: {label}")

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
    require(state not in ("block-comment", "'", '"', "`"), f"unterminated JavaScript token: {label}")
    return "".join(result)

def require_unique_regex(source, pattern, label, flags=0):
    require(len(list(re.finditer(pattern, source, flags))) == 1, label)

require(relu["product"]["id"] == "relu-ai-bridge", "core product id")
require(relu["product"]["name"] == "RELU AI Bridge", "core product name")
require(relu["product"]["core_version"] == "0.3.0", "core version")
require(package["name"] == relu["product"]["id"], "root package name")
require(package["version"] == relu["product"]["core_version"], "root package version")
require(sdk["name"] == "@company/relu-ai-connector", "SDK package name")
require(sdk["version"] == relu["product"]["core_version"], "SDK package version")
require(extension["name"] == "RELU AI Bridge Companion", "Chrome Companion name")
require(extension["version"] == relu["product"]["core_version"], "Chrome Companion version")
version = re.escape(relu["product"]["core_version"])
plugin_code = strip_javascript_comments(plugin_source, "Perfetto plugin")
mcp_code = strip_javascript_comments(mcp_source, "MCP server")
server_code = strip_javascript_comments(server_source, "health server")
require_unique_regex(plugin_code, r"^[ \t]*const PLUGIN_ID = 'io\.company\.RELUPerfettoBridge';[ \t]*$", "Perfetto plugin id", re.MULTILINE)
require_unique_regex(plugin_code, rf"^[ \t]*const PLUGIN_VERSION = '{version}';[ \t]*$", "Perfetto plugin version", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*const COMMAND_SOURCE = 'RELU AI Bridge · Perfetto';[ \t]*$", "Perfetto plugin branding", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*static readonly id = PLUGIN_ID;[ \t]*$", "Perfetto plugin id binding", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*pluginVersion: PLUGIN_VERSION,[ \t]*$", "Perfetto plugin version binding", re.MULTILINE)
require_unique_regex(mcp_code, rf"serverInfo:\s*\{{\s*name:\s*'relu-ai-bridge',\s*version:\s*'{version}'\s*\}}", "MCP serverInfo")
require_unique_regex(server_code, rf"if \(requestUrl\.pathname === '/health'\) \{{\s*return sendJson\(response, 200, \{{\s*ok: true,\s*name:\s*'relu-ai-bridge',\s*version:\s*'{version}',", "health identity")
require(relu["connectors"][0]["number"] == 1, "connector number")
require(relu["connectors"][0]["id"] == "perfetto", "connector id")
require(relu["connectors"][0]["version"] == "0.3.0", "core connector version")
require(relu["connectors"][0]["manifest"] == "connectors/perfetto-v57.2.json", "connector manifest path")
require(data["connector"]["version"] == "0.3.0", "Perfetto connector version")
require(data["connector"]["version"] == relu["connectors"][0]["version"], "core/connector version alignment")
upstream = data["public_baseline"]
require(upstream["repository"] == "https://github.com/google/perfetto.git", "Perfetto repository")
require(upstream["release"] == "v57.2", "Perfetto release")
require(upstream["tag_object_sha"] == "24bdfb9dfa2dc92883761426dd94259756fa197e", "Perfetto tag object")
require(upstream["commit_sha"] == "da1d152cff27890903d158fe96751de3aab883cc", "Perfetto commit")
require(re.fullmatch(r"[0-9a-f]{40}", upstream["commit_sha"]), "Perfetto commit format")
integration = data["integration"]
require(integration["source_plugin_path"] == "plugin/io.company.RELUPerfettoBridge", "source plugin path")
require(integration["source_adapter_path"] == "perfetto_adapter", "source adapter path")
require(integration["target_plugin_path"] == "ui/src/plugins/io.company.RELUPerfettoBridge", "target plugin path")
require(integration["target_adapter_path"] == "ui/src/perfetto_adapter", "target adapter path")
require(data["company_integration_policy"] == {
    "metadata_scope": "company-internal-only",
    "exact_head_required": True,
    "company_adapter_must_be_external": True,
    "external_release_metadata_allowed": False,
}, "company integration policy")
PY

assert_single_file_patch \
  "$PERFETTO_PROJECT_ROOT/$(compat_value integration.enable_patch)" \
  "$(compat_value integration.default_plugins_file)"

plugin_id=$(compat_value integration.plugin_id)
grep -Fq "'$plugin_id'" \
  "$PERFETTO_PROJECT_ROOT/$(compat_value integration.source_plugin_path)/index.ts" || \
  die "plugin ID와 compatibility contract가 다릅니다"

if [ "$#" -eq 1 ]; then
  perfetto_dir=$(canonical_existing_dir "$1")
  assert_git_repository "$perfetto_dir"
  assert_exact_head "$perfetto_dir" "$(compat_value public_baseline.commit_sha)"
  [ "$(git -C "$perfetto_dir" rev-parse "refs/tags/$(compat_value public_baseline.release)")" = \
    "$(compat_value public_baseline.tag_object_sha)" ] || die "Perfetto tag object SHA 불일치"
  default_plugins="$perfetto_dir/$(compat_value integration.default_plugins_file)"
  if grep -Fqx "  '$plugin_id'," "$default_plugins"; then
    "$SCRIPT_DIR/verify-integration.sh" "$perfetto_dir"
    [ ! -e "$perfetto_dir/ui/src/plugins/io.company.PerfettoLocalAI" ] || \
      die "이전 Perfetto plugin ID overlay가 남아 있습니다"
  else
    git -C "$perfetto_dir" apply --check \
      "$PERFETTO_PROJECT_ROOT/$(compat_value integration.enable_patch)"
  fi
fi

info "Perfetto integration smoke test 통과"
