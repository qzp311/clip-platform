# 用户机 / 安装向导 / 绿色包：仅「激活」安装包内已预置的 FunASR 引擎
# - 改写 pyvenv.cfg → 本机 engines\python
# - 瘦身 funasr/__init__.py（避免 Windows 子进程 ACCESS_VIOLATION，保留注册导入）
# - 写入 .clip-ready
# 禁止 pip / 禁止下载。包不完整则直接失败。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File activate-funasr-engine.ps1 -InstallDir "C:\Program Files\ClipAgent"
#   powershell ... -File activate-funasr-engine.ps1 -InstallDir "D:\drama-clip" -Portable

param(
    [string]$InstallDir = "",
    [switch]$Portable
)

$ErrorActionPreference = "Stop"

# 解析安装根：env > -InstallDir > 本脚本所在 scripts\ 的上一级
# （Node 传 -InstallDir:D:\xxx 时 PowerShell 常把 InstallDir 解析成空，必须有 PSScriptRoot 兜底）
if (-not [string]::IsNullOrWhiteSpace($env:CLIP_ACTIVATE_INSTALL_DIR)) {
    $InstallDir = [string]$env:CLIP_ACTIVATE_INSTALL_DIR
}
if ([string]::IsNullOrWhiteSpace($InstallDir) -and -not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $InstallDir = Split-Path -Parent $PSScriptRoot
    Write-Host "clip-activate InstallDir fallback PSScriptRoot parent -> $InstallDir"
}
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    throw "InstallDir 不能为空。请设置 CLIP_ACTIVATE_INSTALL_DIR，或 -InstallDir 'D:\ClipAgent'"
}
# 去掉 \\?\ 扩展前缀
$InstallDir = $InstallDir.Trim()
if ($InstallDir -match '^\\\\\?\\') {
    $InstallDir = $InstallDir -replace '^\\\\\?\\', ''
}
$InstallDir = $InstallDir.TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    throw "InstallDir 无效（规范化后为空）"
}
Write-Host "clip-activate v2 using InstallDir=$InstallDir"
$PythonEmbed = Join-Path $InstallDir "engines\python\python.exe"
$VenvDir = Join-Path $InstallDir "engines\funasr\venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$Cfg = Join-Path $VenvDir "pyvenv.cfg"
$Marker = Join-Path $VenvDir ".clip-ready"

if ($Portable -or (Test-Path (Join-Path $InstallDir "portable.flag"))) {
    $Portable = $true
}

$DataRoot = if ($Portable) {
    Join-Path $InstallDir "data"
} else {
    Join-Path $env:LOCALAPPDATA "ClipAgent"
}
$ModelsDir = Join-Path $DataRoot "models"
$LogDir = Join-Path $DataRoot "logs"
$SetupLog = Join-Path $LogDir "funasr-setup.log"
$AgentLog = Join-Path $LogDir "agent.log"

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format o), $Message
    Write-Host "clip-activate $Message"
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
        Add-Content -Path $SetupLog -Value $line -Encoding UTF8
        $agentLine = "[{0}] [INFO] [funasr-setup] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
        Add-Content -Path $AgentLog -Value $agentLine -Encoding UTF8
    } catch { }
}

function Repair-PyVenvCfg {
    if (-not (Test-Path $Cfg)) { throw "缺少 pyvenv.cfg: $Cfg" }
    if (-not (Test-Path $PythonEmbed)) { throw "缺少内置 Python: $PythonEmbed" }
    $pythonHome = Split-Path $PythonEmbed
    $version = "3.11.9"
    $versionInfo = "3.11.9.final.0"
    foreach ($line in (Get-Content $Cfg)) {
        if ($line -match '^\s*version\s*=\s*(.+)$') { $version = $Matches[1].Trim() }
        if ($line -match '^\s*version_info\s*=\s*(.+)$') { $versionInfo = $Matches[1].Trim() }
    }
    @(
        "home = $pythonHome"
        "implementation = CPython"
        "version_info = $versionInfo"
        "version = $version"
        "executable = $PythonEmbed"
        "include-system-site-packages = false"
        "base-prefix = $pythonHome"
        "base-exec-prefix = $pythonHome"
        "base-executable = $PythonEmbed"
    ) | Set-Content -Path $Cfg -Encoding ASCII
    Write-Log "pyvenv.cfg -> $pythonHome"
}

function Patch-FunasrInit {
    $initPy = Join-Path $VenvDir "Lib\site-packages\funasr\__init__.py"
    if (-not (Test-Path $initPy)) { throw "安装包缺少 funasr 包: $initPy" }
    $bak = "$initPy.clip-heavy-bak"
    # 完整 __init__（含 import_submodules）才能注册 tokenizer；slim 会导致 AutoModel tokenizer_class=None
    if (Test-Path $bak) {
        Copy-Item -LiteralPath $bak -Destination $initPy -Force
        Write-Log "restored funasr/__init__.py from clip-heavy-bak"
        return
    }
    Write-Log "keep existing funasr/__init__.py (no heavy bak)"
}

function Test-EngineOk {
    $code = @'
import importlib.util, sys
spec = importlib.util.find_spec("funasr")
print("FUNASR_SPEC", getattr(spec, "origin", None))
if not spec:
    sys.exit(1)
import torch
v = getattr(torch, "__version__", "")
c = getattr(torch.version, "cuda", None)
print("TORCH", v, c)
# 有 NVIDIA 时要求 CUDA 12.1；无 GPU 时允许 CPU 版 torch
has_nvidia = False
try:
    import subprocess, re
    out = subprocess.check_output(["nvidia-smi", "-L"], encoding="utf-8", errors="ignore")
    has_nvidia = bool(re.search(r"GPU", out))
except Exception:
    pass
if has_nvidia:
    ok = ("+cu121" in v) or (c and str(c).startswith("12.1"))
else:
    ok = ("+cu121" in v) or (c and str(c).startswith("12.1")) or ("+cpu" in v) or (c is None)
sys.exit(0 if ok else 2)
'@
    $tmp = Join-Path $env:TEMP ("clip-activate-check-{0}.py" -f [guid]::NewGuid().ToString("N"))
    $out = "$tmp.out"
    $err = "$tmp.err"
    Set-Content -Path $tmp -Value $code -Encoding ASCII
    try {
        $p = Start-Process -FilePath $VenvPython -ArgumentList @($tmp) `
            -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $out -RedirectStandardError $err
        $text = ""
        if (Test-Path $out) { $text += [string](Get-Content $out -Raw -EA SilentlyContinue) }
        if (Test-Path $err) { $text += "`n" + [string](Get-Content $err -Raw -EA SilentlyContinue) }
        Write-Log ("engine check exit={0}: {1}" -f $p.ExitCode, $text.Trim())
        return ($p.ExitCode -eq 0)
    } finally {
        Remove-Item -Force $tmp, $out, $err -ErrorAction SilentlyContinue
    }
}

# ---- main ----
Write-Log ("activate InstallDir={0} Portable={1}" -f $InstallDir, $Portable)

if (-not (Test-Path $VenvPython)) {
    throw "安装包未包含 FunASR venv（$VenvPython）。请使用完整一键安装包重装，不是网络问题。"
}
if (-not (Test-Path $PythonEmbed)) {
    throw "安装包未包含内置 Python（$PythonEmbed）。请使用完整一键安装包重装。"
}

Repair-PyVenvCfg
Patch-FunasrInit

if (-not (Test-EngineOk)) {
    throw "引擎激活后校验失败（funasr/torch）。安装包不完整或已损坏，请重新安装完整包。"
}

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
Set-Content -Path $Marker -Value (Get-Date -Format o) -Encoding UTF8

if (-not $Portable) {
    # 根据当前引擎实际能力写入后端：有 NVIDIA 走 funasr-gpu，否则 funasr-cpu
    $hasNvidia = $false
    try {
        $smi = & nvidia-smi -L 2>$null
        if ($LASTEXITCODE -eq 0 -and $smi -match 'GPU') { $hasNvidia = $true }
    } catch { }
    if (-not $hasNvidia) {
        try {
            $adapter = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
            if ($adapter -match 'NVIDIA') { $hasNvidia = $true }
        } catch { }
    }
    $asrBackend = if ($hasNvidia) { "funasr-gpu" } else { "funasr-cpu" }
    [Environment]::SetEnvironmentVariable("CLIP_ASR_BACKEND", $asrBackend, "User")
    [Environment]::SetEnvironmentVariable("CLIP_FUNASR_MODELS_DIR", $ModelsDir, "User")
    [Environment]::SetEnvironmentVariable("CLIP_PYTHON", $VenvPython, "User")
    [Environment]::SetEnvironmentVariable("CLIP_REPO_ROOT", $InstallDir, "User")
    Write-Log "set User env backend=$asrBackend"
} else {
    Write-Log "portable mode — skip writing User environment variables"
}

Write-Log "OK CLIP_PYTHON=$VenvPython models=$ModelsDir"
Write-Host "activate-funasr-engine: OK"
exit 0
