# Paper Reader one-click setup (Windows).
#   .\setup.ps1              Install Node packages, build, create the desktop shortcut, check AI tools.
#   .\setup.ps1 -MinerU      Also install MinerU (PDF parser, ~1.5 GB with models) into tools\mineru.
#   .\setup.ps1 -Translate   Also install pdf2zh_next (whole-paper translation) into tools\pdf2zh.
param([switch]$MinerU, [switch]$Translate, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Has($command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }

Step 'Node.js'
if (-not (Has 'node')) { throw 'Node.js 24+ is required: https://nodejs.org/ (or: winget install OpenJS.NodeJS.LTS)' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "Node.js 24+ is required (found $(node --version))." }
Ok "Node $(node --version)"

Step 'npm install + build'
& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
Ok 'Frontend built (dist/)'

# Both Python tools are installed with uv into their own folder under tools\.
function Ensure-Uv {
  if (Has 'uv') { return }
  Warn 'uv not found, installing with winget (astral-sh.uv)...'
  winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (-not (Has 'uv')) { throw 'uv installation failed; install it manually: https://docs.astral.sh/uv/' }
}

if ($MinerU) {
  Step 'MinerU (PDF parser) -> tools\mineru'
  Ensure-Uv
  $root = Join-Path $PSScriptRoot 'tools\mineru'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Push-Location $root
  try {
    & uv venv .venv --python 3.12
    $env:VIRTUAL_ENV = Join-Path $root '.venv'
    & uv pip install -U 'mineru>=4.0,<5'
    if ($LASTEXITCODE -ne 0) { throw 'MinerU install failed.' }
    $env:MINERU_HOME = Join-Path $root 'home'
    # Download the "standard" tier models once (about 1.4 GB).
    & (Join-Path $root '.venv\Scripts\mineru-kit.exe') models download --tier standard
    Ok 'MinerU installed; Paper Reader finds tools\mineru automatically.'
  } finally { Pop-Location }
} elseif (-not (Test-Path 'tools\mineru\.venv\Scripts\mineru-kit.exe')) {
  Warn 'MinerU not installed (needed for figure lists and full-text AI). Re-run: .\setup.ps1 -MinerU'
}

if ($Translate) {
  Step 'pdf2zh_next (whole-paper translation) -> tools\pdf2zh'
  Ensure-Uv
  $root = Join-Path $PSScriptRoot 'tools\pdf2zh'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Push-Location $root
  try {
    & uv venv .venv --python 3.12
    $env:VIRTUAL_ENV = Join-Path $root '.venv'
    & uv pip install -r (Join-Path $PSScriptRoot 'pdf-translate\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pdf2zh_next install failed.' }
    Remove-Item Env:VIRTUAL_ENV
    # pdf2zh_next caps the CLI translator timeout at 300 s; local models (and the bridge's
    # 1800 s request) need more, so raise only that field's limit in the pinned version.
    $model = Join-Path $root '.venv\Lib\site-packages\pdf2zh_next\config\translate_engine_model.py'
    $source = [IO.File]::ReadAllText($model)
    $patched = [regex]::Replace($source, '(clitranslator_timeout: int = Field\([^)]*?)le=300,', '${1}le=1800,')
    if ($patched -ne $source) { [IO.File]::WriteAllText($model, $patched); Ok 'pdf2zh_next timeout limit raised to 1800 s' }
    elseif ($source -notmatch 'le=1800') { Warn 'Could not raise the pdf2zh_next timeout limit; translation may fail validation.' }
    Ok 'Whole-paper translation ready (pdf-translate\Translate-PDF.ps1 finds tools\pdf2zh).'
  } finally { Pop-Location }
} elseif (-not (Test-Path 'tools\pdf2zh\.venv\Scripts\python.exe')) {
  Warn 'Whole-paper translation not installed (optional). Re-run: .\setup.ps1 -Translate'
}

Step 'AI assistants (use your existing subscriptions, no API key)'
if (Has 'codex') { Ok 'Codex CLI found (run "codex login" once if needed)' } else { Warn 'Codex CLI not found: npm install -g @openai/codex ; codex login' }
if (Has 'claude') { Ok 'Claude Code found' } else { Warn 'Claude Code not found (optional): https://docs.anthropic.com/claude-code' }
if (Has 'ollama') { Ok 'Ollama found (selection translation: ollama pull hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M)' } else { Warn 'Ollama not found (optional, local selection translation): https://ollama.com/' }

if (-not $NoShortcut) {
  Step 'Desktop shortcut'
  & (Join-Path $PSScriptRoot 'Create-Desktop-Shortcut.ps1')
}

Write-Host "`nDone. Start with the desktop shortcut or .\Start-Paper-Reader.cmd" -ForegroundColor Green
