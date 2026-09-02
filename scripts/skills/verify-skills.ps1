param(
  [ValidateSet('user', 'project')]
  [string]$Scope = 'user',

  [ValidateSet('claude', 'codex', 'both')]
  [string]$Target = 'both',

  [string]$ProjectPath = (Get-Location).Path,

  [string]$NodeCommand = 'node'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command $NodeCommand -ErrorAction SilentlyContinue)) {
  throw "Node.js 20.11 or newer is required: $NodeCommand"
}

$manager = Join-Path $PSScriptRoot 'manage-skills.mjs'
& $NodeCommand $manager verify --scope $Scope --target $Target --project-root $ProjectPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
