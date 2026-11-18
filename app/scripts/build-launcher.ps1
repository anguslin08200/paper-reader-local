# Compile launcher\PaperReader.cs into "Paper Reader.exe" (with the app icon) beside the app\ folder.
# Uses the .NET Framework C# compiler included with Windows; no extra install is needed.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'C# compiler (csc.exe) not found in .NET Framework 4.' }
# The exe goes beside the app\ folder, so it is the first thing users see.
$output = if ((Split-Path -Leaf $root) -eq 'app') { Join-Path (Split-Path -Parent $root) 'Paper Reader.exe' } else { Join-Path $root 'Paper Reader.exe' }
& $csc /nologo /target:winexe /optimize+ /codepage:65001 `
  "/out:$output" "/win32icon:$(Join-Path $root 'assets\paper-reader.ico')" `
  /reference:System.Windows.Forms.dll (Join-Path $root 'launcher\PaperReader.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
Write-Output "Built: $output"
