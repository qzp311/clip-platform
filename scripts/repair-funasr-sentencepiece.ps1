#Requires -Version 5.1
<#
.SYNOPSIS
  修复 FunASR import sentencepiece 的 ACCESS_VIOLATION（0xC0000005）。

.DESCRIPTION
  1) 消毒 PATH（去掉 torch/nvidia/杂项，只保留 System32 + 本机引擎）
  2) 旁路部署已知完好的 VC CRT DLL（msvcp140 / vcruntime140）到 python / sentencepiece 旁
  3) 优先离线安装 sentencepiece 0.1.99（不依赖 dbghelp，比 0.2.2 更稳）
  4) 若仍失败且存在 vc_redist.x64.exe，静默安装 VC++ 运行库后再验
#>
param(
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
  Write-Host ("[repair-sentencepiece] {0}" -f $Message)
}

function Normalize-InstallDir([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  $t = $PathValue.Trim().Trim('"').Trim("'")
  if ($t.StartsWith('\\?\')) { $t = $t.Substring(4) }
  try { return [System.IO.Path]::GetFullPath($t) } catch { return $t }
}

function Set-CleanPath([string]$InstallDir) {
  $win = $env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($win)) { $win = 'C:\Windows' }
  $parts = @(
    (Join-Path $win 'System32'),
    (Join-Path $win 'SysWOW64'),
    (Join-Path $InstallDir 'engines\python'),
    (Join-Path $InstallDir 'engines\funasr\venv\Scripts'),
    (Join-Path $InstallDir 'engines\funasr\runtime\crt'),
    (Join-Path $win 'System32\WindowsPowerShell\v1.0')
  ) | Where-Object { Test-Path -LiteralPath $_ }
  $env:PATH = ($parts -join ';')
  Write-Step ("PATH cleaned -> {0}" -f $env:PATH)
}

function Copy-CrtBeside([string]$InstallDir) {
  $crtSrcCandidates = @(
    (Join-Path $InstallDir 'engines\funasr\runtime\crt'),
    (Join-Path $PSScriptRoot '..\deploy\windows-packaging\redist\crt-x64'),
    (Join-Path $env:SystemRoot 'System32')
  )
  $dlls = @(
    'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
    'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'
  )
  $targets = @(
    (Join-Path $InstallDir 'engines\python'),
    (Join-Path $InstallDir 'engines\funasr\venv\Scripts'),
    (Join-Path $InstallDir 'engines\funasr\venv\Lib\site-packages\sentencepiece'),
    (Join-Path $InstallDir 'engines\funasr\runtime\crt')
  )
  foreach ($t in $targets) {
    New-Item -ItemType Directory -Force -Path $t | Out-Null
  }

  $copied = 0
  $skipped = 0
  foreach ($dll in $dlls) {
    $src = $null
    foreach ($c in $crtSrcCandidates) {
      $p = Join-Path $c $dll
      if (Test-Path -LiteralPath $p) { $src = $p; break }
    }
    if (-not $src) { continue }
    $srcFull = [System.IO.Path]::GetFullPath($src)
    foreach ($t in $targets) {
      $dest = [System.IO.Path]::GetFullPath((Join-Path $t $dll))
      if ($srcFull -eq $dest) { continue }
      try {
        Copy-Item -Force -LiteralPath $src -Destination $dest -ErrorAction Stop
        $copied++
      } catch {
        $skipped++
        Write-Step ("CRT skip {0}: {1}" -f $dest, $_.Exception.Message)
      }
    }
  }
  Write-Step ("CRT dlls staged (copied={0} skipped={1})" -f $copied, $skipped)

  $sysMsvcp = Join-Path $env:SystemRoot 'System32\msvcp140.dll'
  Write-Step ("System32\msvcp140.dll present={0}" -f (Test-Path -LiteralPath $sysMsvcp))
}

function Test-SentencepieceImport([string]$PythonExe) {
  $tmp = Join-Path $env:TEMP ("clip-sp-probe-{0}.py" -f [guid]::NewGuid().ToString('N'))
  $pyCode = @'
import os, sys
from pathlib import Path
py_dir = Path(sys.executable).resolve().parent
venv = py_dir.parent
sp = venv / "Lib" / "site-packages" / "sentencepiece"
eng = venv.parent.parent / "python"
crt = venv.parent / "runtime" / "crt"
win = Path(os.environ.get("SystemRoot") or r"C:\Windows")
heads = [str(py_dir), str(eng), str(sp), str(crt), str(win / "System32")]
clean = [h for h in heads if Path(h).is_dir()]
rest = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
os.environ["PATH"] = os.pathsep.join(clean + rest)
if hasattr(os, "add_dll_directory"):
    for h in clean:
        try:
            os.add_dll_directory(h)
        except OSError:
            pass
import sentencepiece as s
print("OK", getattr(s, "__version__", "?"))
'@
  try {
    Set-Content -LiteralPath $tmp -Value $pyCode -Encoding UTF8
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $PythonExe $tmp 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    return @{ ExitCode = $code; Output = (($out | Out-String).Trim()) }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}


function Install-Wheel([string]$PythonExe, [string]$WheelPath) {
  Write-Step ("pip install --force-reinstall --no-deps {0}" -f (Split-Path -Leaf $WheelPath))
  & $PythonExe -m pip install --force-reinstall --no-deps --disable-pip-version-check $WheelPath
  if ($LASTEXITCODE -ne 0) {
    throw ("pip install failed: exit={0} wheel={1}" -f $LASTEXITCODE, $WheelPath)
  }
}

function Remove-SentencepiecePackage([string]$InstallDir) {
  $siteSp = Join-Path $InstallDir 'engines\funasr\venv\Lib\site-packages\sentencepiece'
  if (Test-Path -LiteralPath $siteSp) {
    Write-Step 'removing sentencepiece package dir'
    Remove-Item -LiteralPath $siteSp -Recurse -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem (Join-Path $InstallDir 'engines\funasr\venv\Lib\site-packages') -Filter 'sentencepiece-*.dist-info' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

function Install-VcRedist([string]$InstallDir) {
  $vc = Join-Path $InstallDir 'engines\funasr\runtime\vc_redist.x64.exe'
  if (-not (Test-Path -LiteralPath $vc)) {
    Write-Step 'vc_redist.x64.exe not bundled, skip silent install'
    return $false
  }
  Write-Step 'installing VC++ Redistributable x64 (/quiet) — may need admin'
  try {
    $p = Start-Process -FilePath $vc -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
    Write-Step ("vc_redist exit={0}" -f $p.ExitCode)
    # 0 success, 1638 already installed, 3010 reboot required
    return ($p.ExitCode -eq 0 -or $p.ExitCode -eq 1638 -or $p.ExitCode -eq 3010)
  } catch {
    Write-Step ("vc_redist launch failed: {0}" -f $_.Exception.Message)
    return $false
  }
}

# ---- main ----
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = $env:CLIP_ACTIVATE_INSTALL_DIR
}
if ([string]::IsNullOrWhiteSpace($InstallDir) -and $PSScriptRoot) {
  $parent = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $parent 'engines\funasr\venv\Scripts\python.exe')) {
    $InstallDir = $parent
    Write-Step ("InstallDir from PSScriptRoot parent: {0}" -f $InstallDir)
  }
}
$InstallDir = Normalize-InstallDir $InstallDir
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  throw 'InstallDir empty. Set CLIP_ACTIVATE_INSTALL_DIR or pass -InstallDir.'
}

$py = Join-Path $InstallDir 'engines\funasr\venv\Scripts\python.exe'
$wheelDir = Join-Path $InstallDir 'engines\funasr\wheels'
# 0.1.99 无 dbghelp 依赖，优先；0.2.2 作回退
$wheels = @(
  (Join-Path $wheelDir 'sentencepiece-0.1.99-cp311-cp311-win_amd64.whl'),
  (Join-Path $wheelDir 'sentencepiece-0.2.2-cp311-cp311-win_amd64.whl')
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not (Test-Path -LiteralPath $py)) {
  throw ("python missing: {0}" -f $py)
}
if ($wheels.Count -eq 0) {
  throw ("no sentencepiece wheel under {0}" -f $wheelDir)
}

Write-Step ("InstallDir={0}" -f $InstallDir)
Write-Step ("python={0}" -f $py)

Set-CleanPath $InstallDir
Copy-CrtBeside $InstallDir

$probe = Test-SentencepieceImport $py
if ($probe.ExitCode -eq 0 -and ($probe.Output -match '^OK\s')) {
  Write-Step ("already ok: {0}" -f $probe.Output)
  exit 0
}
Write-Step ("probe failed: exit={0} out={1}" -f $probe.ExitCode, $probe.Output)

foreach ($wheel in $wheels) {
  Remove-SentencepiecePackage $InstallDir
  Install-Wheel $py $wheel
  Copy-CrtBeside $InstallDir
  $verify = Test-SentencepieceImport $py
  if ($verify.ExitCode -eq 0 -and ($verify.Output -match '^OK\s')) {
    Write-Step ("repaired with {0}: {1}" -f (Split-Path -Leaf $wheel), $verify.Output)
    exit 0
  }
  Write-Step ("verify failed after {0}: exit={1} out={2}" -f (Split-Path -Leaf $wheel), $verify.ExitCode, $verify.Output)
}

Write-Step 'both wheels failed — trying VC++ redistributable install'
$null = Install-VcRedist $InstallDir
Copy-CrtBeside $InstallDir
Set-CleanPath $InstallDir

foreach ($wheel in $wheels) {
  Remove-SentencepiecePackage $InstallDir
  Install-Wheel $py $wheel
  Copy-CrtBeside $InstallDir
  $verify = Test-SentencepieceImport $py
  if ($verify.ExitCode -eq 0 -and ($verify.Output -match '^OK\s')) {
    Write-Step ("repaired after VC redist with {0}: {1}" -f (Split-Path -Leaf $wheel), $verify.Output)
    exit 0
  }
  Write-Step ("still failing after VC + {0}: exit={1}" -f (Split-Path -Leaf $wheel), $verify.ExitCode)
}

Write-Step 'FAILED. Manual: run engines\funasr\runtime\vc_redist.x64.exe as Admin, disable AV for ClipAgent folder, re-run APPLY-HOTFIX.bat'
throw 'sentencepiece import still failing after reinstall + CRT + VC redist'
