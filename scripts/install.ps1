<#
.SYNOPSIS
  Install mimo-workbuddy-connect: write the MiMoCode provider config and start
  the relay automatically at sign-in.

.DESCRIPTION
  Idempotent. It
    1. writes the provider block into MiMoCode's config so MiMo Desktop lists
       the WorkBuddy models;
    2. registers a per-user Run entry that starts the relay hidden at logon;
    3. starts the relay now so the models work without a reboot.

  The relay only ever listens on 127.0.0.1 and reuses the WorkBuddy app's own
  sign-in. No administrator rights are required.

.PARAMETER Provider
  Which WorkBuddy product to expose: cn (default), ai, or both.

.PARAMETER NoAutostart
  Write the configuration but do not register or start the logon task.

.PARAMETER Uninstall
  Remove the provider configuration and the logon entry.
#>
[CmdletBinding()]
param(
  [ValidateSet('cn', 'ai', 'both')]
  [string]$Provider = 'cn',

  [switch]$NoAutostart,

  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Split-Path -Parent $ScriptDir
$CliPath   = Join-Path $PluginDir 'src\cli.js'
$RelayCmd  = Join-Path $ScriptDir 'relay-hidden.cmd'
$RunKey    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName   = 'MimoWorkBuddyConnect'
$StateDir  = if ($env:MIMO_WORKBUDDY_HOME) { $env:MIMO_WORKBUDDY_HOME } else { Join-Path $env:APPDATA 'mimo-workbuddy-connect' }
$LogFile   = Join-Path $StateDir 'relay.log'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "!!  $Message" -ForegroundColor Yellow }

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    throw "node.exe was not found on PATH. Install Node.js 22.19+ or 24+ and re-run this script."
  }
  return $node.Source
}

# -- Uninstall ---------------------------------------------------------------
if ($Uninstall) {
  Write-Step 'Removing the logon entry'
  if (Get-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $RunKey -Name $RunName -Force
    Write-Host '    logon entry removed'
  } else {
    Write-Host '    no logon entry was present'
  }

  Write-Step 'Removing the MiMoCode provider configuration'
  $node = Get-NodePath
  & $node $CliPath uninstall
  if ($LASTEXITCODE -ne 0) { Write-Warn "uninstall exited with code $LASTEXITCODE" }

  Write-Step 'Stopping any running relay'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$CliPath*" -and $_.CommandLine -like '*serve*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "    stopped pid $($_.ProcessId)"
    }

  Write-Host ''
  Write-Host 'Uninstalled. Restart MiMo Desktop to drop the WorkBuddy models.' -ForegroundColor Green
  return
}

# -- Install -----------------------------------------------------------------
$node = Get-NodePath
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

Write-Step 'Checking the WorkBuddy sign-in'
$providerArg = switch ($Provider) { 'ai' { 'ai' } 'both' { 'cn,ai' } default { 'cn' } }
& $node $CliPath status "--provider=$providerArg"
if ($LASTEXITCODE -ne 0) { Write-Warn 'status reported a problem; see the output above' }

Write-Step 'Writing the MiMoCode provider configuration'
& $node $CliPath install "--provider=$providerArg"
if ($LASTEXITCODE -ne 0) { throw "install failed with exit code $LASTEXITCODE" }

if (-not $NoAutostart) {
  Write-Step 'Registering the relay to start at sign-in'
  # A hidden window keeps the logon experience clean; the log records output.
  $launch = "cmd.exe /c `"$RelayCmd`""
  Set-ItemProperty -Path $RunKey -Name $RunName -Value $launch
  Write-Host "    registered: $RunName"

  Write-Step 'Starting the relay now'
  $alreadyRunning = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$CliPath*" -and $_.CommandLine -like '*serve*' }
  if ($alreadyRunning) {
    Write-Host "    already running (pid $($alreadyRunning[0].ProcessId)); restarting to pick up the new config"
    $alreadyRunning | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 700
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$RelayCmd`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Write-Step 'Verifying the relay'
$ports = @()
if ($Provider -in @('cn', 'both')) { $ports += 8791 }
if ($Provider -in @('ai', 'both')) { $ports += 8792 }
foreach ($port in $ports) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 8
    Write-Host ("    port {0}: signedIn={1} models={2} source={3}" -f $port, $health.signedIn, $health.models, $health.source)
  } catch {
    Write-Warn "port $port did not answer /health: $($_.Exception.Message)"
    Write-Warn "check the log at $LogFile"
  }
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host '  1. Restart MiMo Desktop (or reload its window) so it re-reads the config.'
Write-Host '  2. The WorkBuddy models appear in the model picker.'
Write-Host "  Log: $LogFile"
