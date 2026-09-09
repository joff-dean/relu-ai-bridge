[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDirectory,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [Parameter(Mandatory = $true)]
    [string]$PerfettoOrigin,
    [ValidateRange(1, 65535)]
    [int]$BridgePort = 5746
)

$ErrorActionPreference = 'Stop'
$resolvedInstall = [System.IO.Path]::GetFullPath($InstallDirectory)
$executable = Join-Path $resolvedInstall 'Relu.AI.Bridge.PerfettoNativeHost.exe'
$node = Join-Path $resolvedInstall 'runtime\node.exe'
$bridgeScript = Join-Path $resolvedInstall 'app\scripts\perfetto\run-extension-bridge.mjs'
$proxyScript = Join-Path $resolvedInstall 'app\scripts\perfetto\desktop-mcp-proxy.mjs'
$skillsScript = Join-Path $resolvedInstall 'app\scripts\skills\manage-skills.mjs'
$skillsManifest = Join-Path $resolvedInstall 'app\skills\manifest.json'

foreach ($required in @($executable, $node, $bridgeScript, $proxyScript, $skillsScript, $skillsManifest)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Native Host package is incomplete: $required"
    }
}

$uri = $null
if (-not [System.Uri]::TryCreate($PerfettoOrigin, [System.UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -notin @('http', 'https') -or
    $uri.UserInfo.Length -ne 0 -or
    $uri.Query.Length -ne 0 -or
    $uri.Fragment.Length -ne 0 -or
    $uri.GetLeftPart([System.UriPartial]::Authority) -cne $PerfettoOrigin) {
    throw "PerfettoOrigin must be an exact HTTP(S) origin: $PerfettoOrigin"
}

$configuration = [ordered]@{
    version = 1
    extensionId = $ExtensionId
    perfettoOrigin = $PerfettoOrigin
    bridgePort = $BridgePort
}
$configurationPath = Join-Path $resolvedInstall 'relu-perfetto-native-host.json'
[System.IO.File]::WriteAllText(
    $configurationPath,
    (($configuration | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

$manifest = [ordered]@{
    name = 'com.relu_ai_bridge.perfetto'
    description = 'RELU Perfetto Connector Native Host'
    path = $executable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path $resolvedInstall 'com.relu_ai_bridge.perfetto.json'
[System.IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.relu_ai_bridge.perfetto'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

& $executable '--relu-register-ai-clients'
if ($LASTEXITCODE -ne 0) {
    throw "AI client registration failed with exit code $LASTEXITCODE."
}

Write-Output 'RELU Perfetto Native Host, desktop AI MCP, and verified analysis Skills are configured for the current user.'
