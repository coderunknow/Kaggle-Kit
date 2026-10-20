<#
.SYNOPSIS
Starts Kaggle-Kit with one command on Windows.

.DESCRIPTION
Checks Node.js and npm, then hands over to tools/launcher.mjs, which installs
missing dependencies (network required), builds the client and the proxy when
needed, picks a free port, waits until the backend is ready, opens the browser
and stops the backend cleanly with Ctrl+C.

No administrator rights are required. The script never reads or prints the
Kaggle API key; the key is entered in the browser and handled by the local
proxy.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1 -Port 9000
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

function Stop-WithError {
    param([string]$Message, [string]$Hint)
    Write-Host ""
    Write-Host "Kaggle-Kit could not start." -ForegroundColor Red
    Write-Host "  $Message" -ForegroundColor Red
    if ($Hint) { Write-Host "  $Hint" -ForegroundColor Yellow }
    Write-Host ""
    exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'tools\launcher.mjs'

Write-Host "Kaggle-Kit" -ForegroundColor Cyan

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Stop-WithError "Node.js was not found in PATH." "Install Node.js 20.19 or newer from https://nodejs.org/ (the LTS installer is fine), then close and reopen this window."
}

$nodeVersionText = (& node --version 2>$null)
if (-not $nodeVersionText) {
    Stop-WithError "Node.js is installed but 'node --version' did not answer." "Repair the Node.js installation from https://nodejs.org/ and try again."
}

$nodeVersion = $nodeVersionText.Trim().TrimStart('v')
try {
    $parsedVersion = [version]$nodeVersion
} catch {
    Stop-WithError "The installed Node.js version ('$nodeVersionText') could not be read." "Install Node.js 20.19 or newer from https://nodejs.org/."
}

if ($parsedVersion -lt [version]'20.19.0') {
    Stop-WithError "Node.js $nodeVersion is too old; Kaggle-Kit needs 20.19 or newer." "Install the current LTS version from https://nodejs.org/ and run this script again."
}

$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    Stop-WithError "npm was not found in PATH." "npm ships with Node.js. Repair the Node.js installation from https://nodejs.org/ and reopen this window."
}

if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Stop-WithError "package.json was not found next to the scripts folder." "Keep the project folder together and run this script from its scripts folder."
}

if (-not (Test-Path $launcher)) {
    Stop-WithError "tools\launcher.mjs is missing from the project folder." "Download the release archive again; the file is part of every release."
}

Write-Host "Node.js $nodeVersion and npm are available." -ForegroundColor Green

$launcherArguments = @($launcher)
if ($Port -gt 0) {
    $launcherArguments += @('--port', [string]$Port)
}
if ($NoBrowser) {
    $launcherArguments += '--no-browser'
}
if ($NoInstall) {
    $launcherArguments += '--no-install'
}

Push-Location $root
try {
    & node @launcherArguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $exitCode
