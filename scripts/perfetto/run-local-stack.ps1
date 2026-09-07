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
$CodexCandidates = @()
if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $CodexCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\ChatGPT\resources\codex.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\ChatGPT\resources\codex.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex\codex.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\codex.exe')
    )
}
$VerifiedCodex = $null
foreach ($Candidate in $CodexCandidates) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { continue }
    $Item = Get-Item -LiteralPath $Candidate -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    $Signature = Get-AuthenticodeSignature -LiteralPath $Candidate
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { continue }
    if ($null -eq $Signature.SignerCertificate -or
        $Signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'OpenAI OpCo, LLC') {
        continue
    }
    $VerifiedCodex = $Item.FullName
    break
}
$Launcher = Join-Path $PSScriptRoot 'run-local-stack.mjs'
$CodexRegistrar = Join-Path $PSScriptRoot 'register-codex.mjs'
if ($null -ne $VerifiedCodex) {
    $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $HashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $Digest = $HashAlgorithm.ComputeHash(
            [Text.Encoding]::UTF8.GetBytes("relu-ai-bridge-registrar-mutex-v1`0$Sid`0relu-perfetto"))
    } finally {
        $HashAlgorithm.Dispose()
    }
    $DigestPrefix = -join ($Digest[0..11] | ForEach-Object { $_.ToString('X2') })
    $RegistrationMutex = [Threading.Mutex]::new(
        $false,
        "Global\Relu.AI.Bridge.Perfetto.McpRegistration.$DigestPrefix")
    $RegistrationLease = $false
    try {
        try {
            $RegistrationLease = $RegistrationMutex.WaitOne([TimeSpan]::FromSeconds(15))
        } catch [Threading.AbandonedMutexException] {
            $RegistrationLease = $true
        }
        if (-not $RegistrationLease) {
            throw 'Another user-scope Codex MCP registration is still running'
        }
        & $PerfettoNode $CodexRegistrar $VerifiedCodex $PerfettoNode
        if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed' }
    } finally {
        if ($RegistrationLease) { $RegistrationMutex.ReleaseMutex() }
        $RegistrationMutex.Dispose()
    }
}
$Arguments = @(
    $Launcher,
    $ResolvedPerfetto,
    '--instances', $Instances.ToString(),
    '--ui-port', $UiPort.ToString(),
    '--upstream-port', $UpstreamPort.ToString(),
    '--bridge-port', $BridgePort.ToString()
)
if ($null -ne $VerifiedCodex) {
    $Arguments += @('--codex-cli', $VerifiedCodex)
}
& $PerfettoNode @Arguments
exit $LASTEXITCODE
