# 一键安装 Windows 打包/开发依赖
# 以管理员身份运行 PowerShell 后执行：
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-pack-deps.ps1
#
# 本脚本只做三件事，全部幂等：
#   1. 安装 chocolatey / winget（若尚未安装）
#   2. 安装 Node.js LTS、Rust、Inno Setup 6
#   3. 启用 Windows 长路径支持（避免 funasr venv 路径超过 MAX_PATH）

param(
    [switch]$SkipReboot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
    Write-Host ("[clip-deps] {0}" -f $Message) -ForegroundColor Cyan
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    throw "请以管理员身份运行 PowerShell 后再执行本脚本。"
}

# 1. 长路径支持
Write-Step "启用 Windows 长路径支持..."
$longPathKey = "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem"
$current = Get-ItemProperty -Path $longPathKey -Name "LongPathsEnabled" -ErrorAction SilentlyContinue
if (-not $current -or $current.LongPathsEnabled -ne 1) {
    Set-ItemProperty -Path $longPathKey -Name "LongPathsEnabled" -Value 1
    Write-Step "已启用长路径。" -ForegroundColor Green
    if (-not $SkipReboot) {
        Write-Host "需要重启系统才能生效。请保存工作后重启，然后重新打包。" -ForegroundColor Yellow
        $reboot = Read-Host "是否立即重启？(y/N)"
        if ($reboot -eq "Y" -or $reboot -eq "y") { Restart-Computer }
        exit 0
    }
} else {
    Write-Step "长路径已启用，跳过。"
}

# 2. chocolatey
Write-Step "检查 Chocolatey..."
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Step "正在安装 Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# 3. Node.js LTS
Write-Step "检查 Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Step "正在安装 Node.js LTS..."
    choco install nodejs-lts -y
} else {
    Write-Step ("Node.js 已存在: {0}" -f (& node -v))
}

# 4. Rust
Write-Step "检查 Rust..."
$rust = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rust) {
    Write-Step "正在安装 Rust..."
    $rustup = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustup
    & $rustup -y --default-toolchain stable
} else {
    Write-Step ("Rust 已存在: {0}" -f (& rustc --version))
}

# 5. Inno Setup
Write-Step "检查 Inno Setup..."
$iscc = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    Write-Step "正在安装 Inno Setup 6..."
    choco install innosetup -y
} else {
    Write-Step ("Inno Setup 已存在: {0}" -f $iscc)
}

# 6. WebView2 Runtime（Tauri 桌面壳需要）
Write-Step "检查 WebView2 Runtime..."
$webviewReg = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Test-Path $webviewReg)) {
    Write-Step "正在下载 WebView2 Runtime Bootstrapper..."
    $wv2 = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup.exe"
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $wv2
    Write-Step "请手动运行 $wv2 安装 WebView2 Runtime（无需联网即可静默安装）"
} else {
    Write-Step "WebView2 Runtime 已存在。"
}

# 刷新 PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Step "依赖检查完成。建议重启一次 PowerShell 后再执行 npm run pack:win。"
