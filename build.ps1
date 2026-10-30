# Builds both Windows installers into installer_output\:
#   ServerSnap-Setup-<version>.exe         (admin)
#   ServerSnap-Client-Setup-<version>.exe  (customer)
# Run: powershell -ExecutionPolicy Bypass -File build.ps1
# Needs: npm install done, Inno Setup 6.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$ver = $pkg.version
$build = Join-Path $root 'build'
Write-Host "Building ServerSnap $ver"

if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory $build | Out-Null

# 1. Electron runtime: the official files exactly as npm downloaded them (checksum-verified by
#    the electron package). Never changed: Smart App Control trusts the official electron.exe.
$dist = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $dist 'electron.exe'))) { throw 'Run npm install first (node_modules\electron\dist is missing).' }
Copy-Item $dist (Join-Path $build 'electron') -Recurse
$h1 = (Get-FileHash (Join-Path $dist 'electron.exe')).Hash
$h2 = (Get-FileHash (Join-Path $build 'electron\electron.exe')).Hash
if ($h1 -ne $h2) { throw 'electron.exe changed while copying' }

# 2. The app: our JavaScript + the pure-JavaScript SSH library (no native or unsigned programs).
function Stage($dest, [switch]$Client) {
  New-Item -ItemType Directory $dest | Out-Null
  foreach ($f in 'main.js', 'admin-main.js', 'client-main.js', 'uninstall.js', 'preload.js') { Copy-Item (Join-Path $root $f) $dest }
  foreach ($d in 'src', 'ui') { Copy-Item (Join-Path $root $d) (Join-Path $dest $d) -Recurse }
  New-Item -ItemType Directory (Join-Path $dest 'assets') | Out-Null
  Copy-Item (Join-Path $root 'assets\icon.png'), (Join-Path $root 'assets\icon.ico') (Join-Path $dest 'assets')
  # package.json without scripts / dev tools; productName decides where settings are kept
  $p = [ordered]@{ name = $pkg.name; productName = $pkg.productName; version = $ver; description = $pkg.description; main = 'main.js'; private = $true; dependencies = $pkg.dependencies }
  ($p | ConvertTo-Json -Depth 5) | Set-Content (Join-Path $dest 'package.json') -Encoding ascii
  $nm = Join-Path $dest 'node_modules'
  New-Item -ItemType Directory $nm | Out-Null
  $deps = npm ls --omit=dev --all --parseable 2>$null | Select-Object -Skip 1
  foreach ($d in $deps) { Copy-Item $d (Join-Path $nm (Split-Path $d -Leaf)) -Recurse }
  # ssh2's helper for the PuTTY agent: an unsigned program we never use
  Get-ChildItem $nm -Recurse -Include *.exe, *.node, *.dll | Remove-Item -Force
  if ($Client) { Set-Content (Join-Path $dest 'client.flag') 'This copy opens as ServerSnap Client.' -Encoding ascii }
}
Stage (Join-Path $build 'app')
Stage (Join-Path $build 'client-app') -Client

# 3. Installers
$iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
if (-not (Test-Path $iscc)) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $iscc)) { throw 'Inno Setup 6 is not installed.' }
& $iscc /Q "/DMyAppVersion=$ver" (Join-Path $root 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed (admin)' }
& $iscc /Q "/DMyAppVersion=$ver" /DCLIENT (Join-Path $root 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed (client)' }

Get-ChildItem (Join-Path $root 'installer_output') -Filter "*-$ver.exe" | ForEach-Object {
  '{0}  {1:N0} MB  sha256 {2}' -f $_.Name, ($_.Length / 1MB), (Get-FileHash $_.FullName).Hash
}
