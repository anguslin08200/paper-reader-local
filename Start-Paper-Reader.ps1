# Launch Paper Reader as a desktop-style app window (Chrome/Edge --app: no tabs or address bar).
# Starts the local server hidden when it is not running yet, then opens the app window.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# Pin data location and port even if the calling environment has test overrides.
$env:PAPER_READER_RUNTIME_DIR = Join-Path $PSScriptRoot '.runtime'
$env:PAPER_READER_ROOT = Join-Path $PSScriptRoot '.runtime\library'
$env:PORT = '3080'
$url = 'http://127.0.0.1:3080'
New-Item -ItemType Directory -Force -Path '.runtime' | Out-Null

if (-not (Test-Path 'dist\index.html')) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed. Run npm install and try again.' }
}

# Reuse a running server; otherwise start it hidden and wait until it answers.
$ready = $false
$client = New-Object Net.Sockets.TcpClient
try { $client.Connect('127.0.0.1', 3080); $ready = $true } catch {} finally { $client.Dispose() }
if (-not $ready) {
  Start-Process -FilePath 'node.exe' -ArgumentList 'src/server/index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput '.runtime/server.log' -RedirectStandardError '.runtime/server-error.log'
  for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ready = $true } } catch {}
  }
  if (-not $ready) { throw 'Server did not become ready. Check .runtime/server-error.log.' }
}

# App window: prefer Chrome, then Edge; fall back to the default browser.
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) { Start-Process -FilePath $browser -ArgumentList "--app=$url", '--window-size=1500,950' }
else { Start-Process $url }
