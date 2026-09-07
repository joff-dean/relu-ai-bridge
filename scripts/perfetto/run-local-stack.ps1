[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$PerfettoDir,
    [ValidateRange(1, 8)]
    [int]$Instances = 1,
    [ValidateRange(1, 65535)]
    [int]$UiPort = 10000,
    [ValidateRange(1, 65535)]
    [int]$UpstreamPort = 11000,
    [ValidateRange(1, 65535)]
    [int]$BridgePort = 5746
)

$ErrorActionPreference = 'Stop'
$ExpectedPerfettoCommit = 'add693d8b338ba9599dbcbc3e300b1ab8c000897'
$ResolvedPerfetto = (Resolve-Path -LiteralPath $PerfettoDir).Path
$Head = (& git -C $ResolvedPerfetto rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $Head -cne $ExpectedPerfettoCommit) {
    throw "Perfetto must be the exact v58.2 commit $ExpectedPerfettoCommit"
}

$PluginDir = Join-Path $ResolvedPerfetto 'ui\src\plugins\io.company.RELUPerfettoBridge'
$AdapterDir = Join-Path $ResolvedPerfetto 'ui\src\perfetto_adapter'
$DefaultPlugins = Join-Path $ResolvedPerfetto 'ui\src\core\embedder\default_plugins.ts'
foreach ($Required in @(
    (Join-Path $PluginDir '.relu-ai-bridge-managed'),
    (Join-Path $PluginDir 'bootstrap.ts'),
    (Join-Path $PluginDir 'index.ts'),
    (Join-Path $AdapterDir '.relu-ai-bridge-managed'),
    $DefaultPlugins
)) {
    if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
        throw "Verified RELU Perfetto overlay is missing: $Required"
    }
}
$PluginLiteralCount = @(
    Select-String -LiteralPath $DefaultPlugins -SimpleMatch "'io.company.RELUPerfettoBridge'"
).Count
if ($PluginLiteralCount -ne 1) {
    throw 'RELU Perfetto plugin must be enabled exactly once'
}

$PerfettoNode = Join-Path $ResolvedPerfetto 'ui\node.exe'
if (-not (Test-Path -LiteralPath $PerfettoNode -PathType Leaf)) {
    throw "Perfetto Node runtime is missing: $PerfettoNode"
}
$Launcher = Join-Path $PSScriptRoot 'run-local-stack.mjs'
$Arguments = @(
    $Launcher,
    $ResolvedPerfetto,
    '--instances', $Instances.ToString(),
    '--ui-port', $UiPort.ToString(),
    '--upstream-port', $UpstreamPort.ToString(),
    '--bridge-port', $BridgePort.ToString()
)
& $PerfettoNode @Arguments
exit $LASTEXITCODE
