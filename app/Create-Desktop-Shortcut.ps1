# Create a "Paper Reader" desktop shortcut that starts the app without a console window.
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop 'Paper Reader.lnk'))
# Prefer the compiled launcher (Paper Reader.exe); fall back to hidden PowerShell.
# The exe normally sits one level up, beside the app\ folder.
$exe = @((Join-Path (Split-Path -Parent $PSScriptRoot) 'Paper Reader.exe'), (Join-Path $PSScriptRoot 'Paper Reader.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) {
  $link.TargetPath = $exe
  $link.Arguments = ''
} else {
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'Start-Paper-Reader.ps1')`""
}
$link.WorkingDirectory = $PSScriptRoot
$link.IconLocation = Join-Path $PSScriptRoot 'assets\paper-reader.ico'
$link.Description = 'Paper Reader：論文閱讀、AI 助手、螢光筆筆記'
$link.WindowStyle = 7
$link.Save()
Write-Output "Created: $(Join-Path $desktop 'Paper Reader.lnk')"
