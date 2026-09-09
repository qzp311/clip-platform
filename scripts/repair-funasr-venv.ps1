# 急救：修复「装到 Program Files 后 FunASR 不可用」
# 原因：venv/pyvenv.cfg 仍指向打包机路径（不是网络问题）
#
# 用法（管理员 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair-funasr-venv.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File repair-funasr-venv.ps1 -InstallDir "C:\Program Files\ClipAgent"

param(
    [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
if (-not $InstallDir) {
    if (Test-Path "C:\Program Files\ClipAgent\engines\funasr\venv\Scripts\python.exe") {
        $InstallDir = "C:\Program Files\ClipAgent"
    } elseif (Test-Path "D:\Program Files\ClipAgent\engines\funasr\venv\Scripts\python.exe") {
        $InstallDir = "D:\Program Files\ClipAgent"
    } else {
        $InstallDir = "C:\Program Files\ClipAgent"
    }
}

$Setup = Join-Path $InstallDir "scripts\setup-funasr-bundled.ps1"
if (-not (Test-Path $Setup)) {
    throw "找不到 setup-funasr-bundled.ps1: $Setup — 请先更新安装目录中的 scripts"
}

Write-Host "RepairOnly → $InstallDir"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Setup -InstallDir $InstallDir -RepairOnly
if ($LASTEXITCODE -ne 0) {
    throw "RepairOnly 失败 exit=$LASTEXITCODE，见 %LOCALAPPDATA%\ClipAgent\logs\funasr-setup.log"
}
Write-Host "OK — 请重启 drama-clip 托盘"
