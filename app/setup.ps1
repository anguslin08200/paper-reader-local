# Paper Reader 一鍵安裝（Windows）。通常由 Paper Reader.exe 第一次執行時自動呼叫。
#   .\setup.ps1              安裝套件、建置、建立桌面捷徑、檢查 AI 工具（缺 Node.js 會自動安裝）。
#   .\setup.ps1 -MinerU      另外安裝 MinerU（PDF 解析，含模型約 1.5 GB）到 tools\mineru。
#   .\setup.ps1 -Translate   另外安裝 pdf2zh_next（整篇翻譯）到 tools\pdf2zh。
#   -NoShortcut 不建立桌面捷徑；-NoPrompt 不詢問（自動化測試用，例如 GitHub Actions）。
param([switch]$MinerU, [switch]$Translate, [switch]$NoShortcut, [switch]$NoPrompt)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
# 中文訊息在舊版主控台也能正確顯示。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$interactive = -not ($NoPrompt -or $env:CI)
function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Has($command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }
# 安裝新工具後重新讀取 PATH，不必重開視窗。
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  # A newly installed Node.js (and its global npm tools) must win over any older copy on PATH.
  $env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:Path"
}
# External programs (npm, uv, winget, ...) print warnings on stderr. When output is captured,
# Windows PowerShell turns those lines into errors, which 'Stop' would make fatal, so they run with
# 'Continue' and success is judged by their exit code ($LASTEXITCODE) instead.
function Native([scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $previous }
}
function Node-Major { if (Has 'node') { [int]((node --version).TrimStart('v').Split('.')[0]) } else { 0 } }

Step 'Node.js'
if ((Node-Major) -lt 24) {
  Warn '找不到 Node.js 24 以上，正在自動安裝 Node.js LTS...'
  if (Has 'winget') {
    Native { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Null }
  } else {
    # 沒有 winget（例如舊版 Windows 或伺服器）：從 nodejs.org 下載官方 LTS 安裝檔。
    $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') |
      Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 24 } | Select-Object -First 1
    $msi = Join-Path $env:TEMP "node-$($release.version)-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/node-$($release.version)-x64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Verb RunAs -Wait
  }
  Refresh-Path
  if ((Node-Major) -lt 24) { throw 'Node.js 安裝失敗，請到 https://nodejs.org/ 下載 LTS 版安裝後再執行一次。' }
}
Ok "Node $(node --version)"

Step '安裝套件並建置'
Native { & npm.cmd install }
if ($LASTEXITCODE -ne 0) { throw 'npm install 失敗。' }
Native { & npm.cmd run build }
if ($LASTEXITCODE -ne 0) { throw '建置失敗。' }
Ok '前端已建置（dist/）'

# MinerU 與整篇翻譯都用 uv 安裝到 tools\ 底下各自的資料夾。
function Ensure-Uv {
  if (Has 'uv') { return }
  Warn '找不到 uv，正在安裝...'
  if (Has 'winget') { Native { winget install --id astral-sh.uv -e --silent --accept-source-agreements --accept-package-agreements | Out-Null } }
  Refresh-Path
  if (-not (Has 'uv')) {
    # 沒有 winget 時改用 uv 官方安裝腳本（裝到使用者資料夾，不需要管理員權限）。
    Native { Invoke-RestMethod 'https://astral.sh/uv/install.ps1' | Invoke-Expression }
    Refresh-Path
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  }
  if (-not (Has 'uv')) { throw 'uv 安裝失敗，請參考 https://docs.astral.sh/uv/ 手動安裝。' }
}

if ($MinerU) {
  Step 'MinerU（PDF 解析）-> tools\mineru'
  Ensure-Uv
  $root = Join-Path $PSScriptRoot 'tools\mineru'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Push-Location $root
  try {
    Native { & uv venv .venv --python 3.12 }
    if ($LASTEXITCODE -ne 0) { throw 'Python 環境建立失敗。' }
    $env:VIRTUAL_ENV = Join-Path $root '.venv'
    Native { & uv pip install -U 'mineru>=4.0,<5' }
    if ($LASTEXITCODE -ne 0) { throw 'MinerU 安裝失敗。' }
    Remove-Item Env:VIRTUAL_ENV
    $env:MINERU_HOME = Join-Path $root 'home'
    # 下載 standard 等級模型（約 1.4 GB，只需一次）。
    Native { & (Join-Path $root '.venv\Scripts\mineru-kit.exe') models download --tier standard }
    if ($LASTEXITCODE -ne 0) { throw 'MinerU 模型下載失敗。' }
    Ok 'MinerU 已安裝，Paper Reader 會自動找到 tools\mineru。'
  } finally { Pop-Location }
} elseif (-not (Test-Path 'tools\mineru\.venv\Scripts\mineru-kit.exe')) {
  Warn '尚未安裝 MinerU（圖表清單與全文 AI 需要）。之後可執行：.\setup.ps1 -MinerU'
}

if ($Translate) {
  Step 'pdf2zh_next（整篇翻譯）-> tools\pdf2zh'
  Ensure-Uv
  $root = Join-Path $PSScriptRoot 'tools\pdf2zh'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Push-Location $root
  try {
    Native { & uv venv .venv --python 3.12 }
    if ($LASTEXITCODE -ne 0) { throw 'Python 環境建立失敗。' }
    $env:VIRTUAL_ENV = Join-Path $root '.venv'
    Native { & uv pip install -r (Join-Path $PSScriptRoot 'pdf-translate\requirements.txt') }
    if ($LASTEXITCODE -ne 0) { throw 'pdf2zh_next 安裝失敗。' }
    Remove-Item Env:VIRTUAL_ENV
    # pdf2zh_next 把 CLI 翻譯逾時上限設為 300 秒；本機模型（以及橋接程式的 1800 秒請求）需要更久，
    # 因此只放寬固定版本中這一個欄位的上限。
    $model = Join-Path $root '.venv\Lib\site-packages\pdf2zh_next\config\translate_engine_model.py'
    $source = [IO.File]::ReadAllText($model)
    $patched = [regex]::Replace($source, '(clitranslator_timeout: int = Field\([^)]*?)le=300,', '${1}le=1800,')
    if ($patched -ne $source) { [IO.File]::WriteAllText($model, $patched); Ok 'pdf2zh_next 逾時上限已放寬為 1800 秒' }
    elseif ($source -notmatch 'le=1800') { Warn '無法放寬 pdf2zh_next 逾時上限，翻譯可能驗證失敗。' }
    Ok '整篇翻譯已就緒（pdf-translate\Translate-PDF.ps1 會找到 tools\pdf2zh）。'
  } finally { Pop-Location }
} elseif (-not (Test-Path 'tools\pdf2zh\.venv\Scripts\python.exe')) {
  Warn '尚未安裝整篇翻譯（選用）。之後可執行：.\setup.ps1 -Translate'
}

Step 'AI 助手（使用你既有的訂閱，不需要 API key）'
if (-not (Has 'codex') -and -not (Has 'claude')) {
  Warn '找不到 Codex CLI 或 Claude Code，正在安裝 Codex CLI...'
  Native { & npm.cmd install -g @openai/codex }
  Refresh-Path
}
if (Has 'codex') {
  Ok '已找到 Codex CLI'
  # 尚未登入時，在這個視窗直接引導登入（會開啟瀏覽器，用 ChatGPT 帳號登入）。
  Native { & codex login status *> $null }
  if ($LASTEXITCODE -ne 0 -and $interactive) {
    $answer = Read-Host '  要現在登入 Codex（ChatGPT 帳號）嗎？[Y/n]'
    if ($answer -notmatch '^[nN]') { Native { & codex login } }
  } elseif ($LASTEXITCODE -ne 0) { Warn 'Codex 尚未登入，之後執行：codex login' }
} else { Warn '找不到 Codex CLI：npm install -g @openai/codex，然後 codex login' }
if (Has 'claude') { Ok '已找到 Claude Code' } else { Warn '找不到 Claude Code（選用）：https://docs.anthropic.com/claude-code' }
if (Has 'ollama') { Ok '已找到 Ollama（選區翻譯：ollama pull hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M）' } else { Warn '找不到 Ollama（選用，本機選區翻譯）：https://ollama.com/' }

if (-not $NoShortcut) {
  Step '桌面捷徑'
  & (Join-Path $PSScriptRoot 'Create-Desktop-Shortcut.ps1')
}

Write-Host "`n完成！之後雙擊 Paper Reader.exe 或桌面的「Paper Reader」捷徑即可開啟。" -ForegroundColor Green
