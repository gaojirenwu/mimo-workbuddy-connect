# Package the release into a zip for handoff.
#
# Excludes: runtime state, node_modules, and anything machine-specific.
# Run: powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
[CmdletBinding()]
param(
  [string]$OutDir = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$name = "$($pkg.name)-$($pkg.version)"
$zip = Join-Path $OutDir "$name.zip"
$stage = Join-Path ([IO.Path]::GetTempPath()) "$name-stage"

Write-Host "==> Packaging $name" -ForegroundColor Cyan

# Fresh staging directory.
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Top-level files worth shipping.
$includeFiles = @('.gitignore', 'LICENSE', 'README.md', 'CHANGELOG.md', 'RELEASE-0.1.1.md', 'HANDOFF.md', 'package.json')
foreach ($f in $includeFiles) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src -Destination $stage }
  else { Write-Host "    (skip missing $f)" -ForegroundColor DarkYellow }
}

# Directories worth shipping.
foreach ($d in @('src', 'scripts', 'test')) {
  $src = Join-Path $root $d
  if (Test-Path $src) { Copy-Item $src -Destination $stage -Recurse }
}

# Nothing generated or machine-specific may travel.
$banned = @('node_modules', '.workbuddy', 'relay.log', '.DS_Store', 'Thumbs.db')
Get-ChildItem $stage -Recurse -Force -File | Where-Object {
  $rel = $_.FullName.Substring($stage.Length + 1)
  $bad = $false
  foreach ($b in $banned) { if ($rel -like "*$b*") { $bad = $true } }
  if ($_.Extension -eq '.log') { $bad = $true }
  if ($bad) { Remove-Item $_.FullName -Force; Write-Host "    excluded $rel" -ForegroundColor DarkGray }
}

# Fail loudly if anything secret-looking slipped in.
$suspicious = Get-ChildItem $stage -Recurse -File | Select-String -Pattern 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|passToken["'':\s]+[A-Za-z0-9+/=]{40,}' -ErrorAction SilentlyContinue
if ($suspicious) {
  Write-Host '!! possible secret found; aborting' -ForegroundColor Red
  $suspicious | Select-Object -First 5 | ForEach-Object { Write-Host "   $($_.Path):$($_.LineNumber)" }
  exit 1
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$item = Get-Item $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host ''
Write-Host '==> Done' -ForegroundColor Green
Write-Host "    file  : $($item.FullName)"
Write-Host "    size  : $([math]::Round($item.Length / 1KB, 1)) KB"
Write-Host "    sha256: $hash"
