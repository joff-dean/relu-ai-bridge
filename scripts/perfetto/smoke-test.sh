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
  "$PERFETTO_PROJECT_ROOT/src/server.mjs" \
  "$PERFETTO_PROJECT_ROOT/sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/Relu.AI.Bridge.DesktopConnector.csproj" \
  "$PERFETTO_PROJECT_ROOT/skills/manifest.json" \
  "$PERFETTO_PROJECT_ROOT/skills" \
  "$PERFETTO_PROJECT_ROOT/sdk/relu-web-connector.js" \
  "$PERFETTO_PROJECT_ROOT/sdk-dotnet/src/Relu.AI.Bridge.DesktopConnector/ReluDesktopConnectorOptions.cs" <<'PY'
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

relu = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
data = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
package = json.loads(pathlib.Path(sys.argv[3]).read_text(encoding="utf-8"))
sdk = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))
extension = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))
plugin_source = pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")
mcp_source = pathlib.Path(sys.argv[7]).read_text(encoding="utf-8")
server_source = pathlib.Path(sys.argv[8]).read_text(encoding="utf-8")
dotnet_project = pathlib.Path(sys.argv[9])
skills_manifest_path = pathlib.Path(sys.argv[10])
skills_root = pathlib.Path(sys.argv[11])
web_connector_source = pathlib.Path(sys.argv[12]).read_text(encoding="utf-8")
dotnet_options_source = pathlib.Path(sys.argv[13]).read_text(encoding="utf-8")

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

def strip_csharp_comments(source, label):
    result = []
    state = "code"
    index = 0
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if character in ("'", '"'):
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
    require(state not in ("block-comment", "'", '"'), f"unterminated C# token: {label}")
    return "".join(result)

def require_unique_regex(source, pattern, label, flags=0):
    require(len(list(re.finditer(pattern, source, flags))) == 1, label)

require(relu["product"]["id"] == "relu-ai-bridge", "core product id")
require(relu["product"]["name"] == "RELU AI Bridge", "core product name")
require(relu["product"]["core_version"] == "0.5.0", "core version")
require(package["name"] == relu["product"]["id"], "root package name")
require(package["version"] == relu["product"]["core_version"], "root package version")
require(sdk["name"] == "@company/relu-ai-connector", "SDK package name")
require(sdk["version"] == relu["product"]["core_version"], "SDK package version")
dotnet_root = ET.fromstring(dotnet_project.read_text(encoding="utf-8"))
require(dotnet_root.tag == "Project" and dotnet_root.attrib == {"Sdk": "Microsoft.NET.Sdk"}, ".NET SDK project root")
dotnet_elements = list(dotnet_root.iter())

def xml_local_name(tag):
    return tag.rsplit("}", 1)[-1].casefold()

def require_exact_unconditional_property(name, expected, label):
    all_nodes = [element for element in dotnet_elements if xml_local_name(element.tag) == name.casefold()]
    direct = []
    for group in list(dotnet_root):
        if xml_local_name(group.tag) != "propertygroup":
            continue
        for node in list(group):
            if xml_local_name(node.tag) == name.casefold():
                direct.append((group, node))
    valid = len(all_nodes) == 1 and len(direct) == 1
    if valid:
        group, node = direct[0]
        valid = (group.tag == "PropertyGroup" and node.tag == name
            and not group.attrib and not node.attrib and not list(node)
            and (node.text or "").strip() == expected)
    require(valid, label)

require_exact_unconditional_property("TargetFramework", "net8.0", ".NET SDK target")
require_exact_unconditional_property("Version", relu["product"]["core_version"], ".NET SDK version")
for forbidden_property in ("TargetFrameworks", "PackageVersion", "VersionPrefix", "VersionSuffix"):
    require(not any(xml_local_name(element.tag) == forbidden_property.casefold() for element in dotnet_elements), f".NET SDK forbidden override: {forbidden_property}")
for forbidden_element in ("Import", "ImportGroup", "Target", "UsingTask"):
    require(not any(xml_local_name(element.tag) == forbidden_element.casefold() for element in dotnet_elements), f".NET SDK executable override: {forbidden_element}")
dotnet_repo = dotnet_project.parents[3]
tracked = subprocess.run(
    ["git", "-C", str(dotnet_repo), "ls-files", "-z"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
require(tracked.returncode == 0, ".NET SDK override inventory")
tracked_paths = {path.casefold() for path in tracked.stdout.decode("utf-8").split("\0") if path}
override_paths = {
    name
    for directory in ("", "sdk-dotnet/", "sdk-dotnet/src/", "sdk-dotnet/src/relu.ai.bridge.desktopconnector/")
    for name in (f"{directory}directory.build.props", f"{directory}directory.build.targets")
}
require(tracked_paths.isdisjoint(override_paths), ".NET SDK Directory.Build override")
skills_manifest = json.loads(skills_manifest_path.read_text(encoding="utf-8"))
require(skills_manifest.get("schemaVersion") == 1, "Skill manifest schema")
require(skills_manifest.get("suite") == "relu-ai-bridge-analysis-skills", "Skill manifest suite")
require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", skills_manifest.get("suiteVersion", "")) is not None, "Skill suite version")
manifested_skill_dirs = []
for skill in skills_manifest.get("skills", []):
    directory = skill.get("directory", "")
    require(re.fullmatch(r"[a-z0-9-]{1,63}", directory) is not None, "Skill directory")
    require(skill.get("name") == directory, "Skill name/directory")
    manifested_skill_dirs.append(directory)
    records = skill.get("files", [])
    require(isinstance(records, list) and records, "Skill file inventory")
    for record in records:
        relative = record.get("path", "")
        require(relative and "\\" not in relative and not relative.startswith("/") and ".." not in relative.split("/"), "Skill relative path")
        content = (skills_root / directory / relative).read_bytes()
        require(len(content) == record.get("bytes"), "Skill file byte length")
        require(hashlib.sha256(content).hexdigest() == record.get("sha256"), "Skill file digest")
require(sorted(path.name for path in skills_root.iterdir() if path.name != "manifest.json") == sorted(manifested_skill_dirs), "Skill directory inventory")
require(extension["name"] == "RELU AI Bridge Companion", "Chrome Companion name")
require(extension["version"] == relu["product"]["core_version"], "Chrome Companion version")
version = re.escape(relu["product"]["core_version"])
plugin_code = strip_javascript_comments(plugin_source, "Perfetto plugin")
mcp_code = strip_javascript_comments(mcp_source, "MCP server")
server_code = strip_javascript_comments(server_source, "health server")
web_connector_code = strip_javascript_comments(web_connector_source, "web connector SDK")
require('@"' not in dotnet_options_source and '@$"' not in dotnet_options_source and '"""' not in dotnet_options_source, ".NET connector unsupported string form")
require(re.search(r"^[ \t]*#", dotnet_options_source, re.MULTILINE) is None, ".NET connector preprocessor directive")
dotnet_options_code = strip_csharp_comments(dotnet_options_source, ".NET connector options")
require_unique_regex(plugin_code, r"\b(?:const|let|var)[ \t]+PLUGIN_VERSION[ \t]*=", "Perfetto plugin version declaration count")
require_unique_regex(mcp_code, r"\bserverInfo\b[ \t]*:", "MCP serverInfo declaration count")
require_unique_regex(server_code, r"['\"]/health['\"]", "health route declaration count")
require_unique_regex(web_connector_code, r"\bthis\.connectorVersion[ \t]*=", "web connector version assignment count")
require_unique_regex(dotnet_options_code, r"\b(?:public[ \t]+)?string[ \t]+ConnectorVersion[ \t]*\{", ".NET connector version declaration count")
require_unique_regex(plugin_code, r"^[ \t]*const PLUGIN_ID = 'io\.company\.RELUPerfettoBridge';[ \t]*$", "Perfetto plugin id", re.MULTILINE)
require_unique_regex(plugin_code, rf"^[ \t]*const PLUGIN_VERSION = '{version}';[ \t]*$", "Perfetto plugin version", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*const COMMAND_SOURCE = 'RELU AI Bridge · Perfetto';[ \t]*$", "Perfetto plugin branding", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*static readonly id = PLUGIN_ID;[ \t]*$", "Perfetto plugin id binding", re.MULTILINE)
require_unique_regex(plugin_code, r"^[ \t]*pluginVersion: PLUGIN_VERSION,[ \t]*$", "Perfetto plugin version binding", re.MULTILINE)
require_unique_regex(mcp_code, rf"serverInfo:\s*\{{\s*name:\s*'relu-ai-bridge',\s*version:\s*'{version}'\s*\}}", "MCP serverInfo")
require_unique_regex(server_code, rf"if \(requestUrl\.pathname === '/health'\) \{{\s*return sendJson\(response, 200, \{{\s*ok: true,\s*name:\s*'relu-ai-bridge',\s*version:\s*'{version}',", "health identity")
require_unique_regex(web_connector_code, rf"^[ \t]*this\.connectorVersion = String\(options\.connectorVersion \?\? '{version}'\);[ \t]*$", "web connector default version", re.MULTILINE)
require_unique_regex(dotnet_options_code, rf'^[ \t]*public string ConnectorVersion \{{ get; init; \}} = "{version}";[ \t]*$', ".NET connector default version", re.MULTILINE)
require(relu["connectors"][0]["number"] == 1, "connector number")
require(relu["connectors"][0]["id"] == "perfetto", "connector id")
require(relu["connectors"][0]["version"] == "0.5.0", "core connector version")
require(relu["connectors"][0]["manifest"] == "connectors/perfetto-v57.2.json", "connector manifest path")
require(data["connector"]["version"] == "0.5.0", "Perfetto connector version")
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
