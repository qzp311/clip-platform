# FunASR GPU/CPU setup — bundled Python in install dir
# 安装时根据本机是否有 NVIDIA GPU 自动选择 CUDA 版或 CPU 版 PyTorch
# 优先使用安装包内预置的 wheel/venv 做离线或增量安装，失败时用国内镜像兜底。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup-funasr-bundled.ps1 [-InstallDir "C:\Program Files\ClipAgent"] [-RepairOnly]

param(
    [string]$InstallDir = "",
    [switch]$RepairOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$LogPrefix = "clip-setup"

if (-not $InstallDir) {
    $InstallDir = Split-Path -Parent $PSScriptRoot
}
$InstallDir = $InstallDir.Trim().TrimEnd('\', '/')

$PythonEmbed = Join-Path $InstallDir "engines\python\python.exe"
$VenvDir = Join-Path $InstallDir "engines\funasr\venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"
$Req = Join-Path $InstallDir "engines\funasr\python\requirements-funasr.txt"
$ModelsDir = Join-Path $env:LOCALAPPDATA "ClipAgent\models"
$Marker = Join-Path $VenvDir ".clip-ready"
$LocalLogDir = Join-Path $env:LOCALAPPDATA "ClipAgent\logs"
$InstallLogDir = Join-Path $InstallDir "engines\funasr"
$SetupLog = Join-Path $InstallLogDir "setup.log"
$WheelDir = Join-Path $InstallDir "engines\funasr\wheels"
$RuntimeDir = Join-Path $InstallDir "engines\funasr\runtime"

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format o), $Message
    try { Write-Host "$LogPrefix $Message" } catch { }
    try {
        if (-not (Test-Path $LocalLogDir)) { New-Item -ItemType Directory -Force -Path $LocalLogDir | Out-Null }
        Add-Content -Path (Join-Path $LocalLogDir "funasr-setup.log") -Value $line -Encoding UTF8
    } catch { }
    try {
        if (-not (Test-Path $InstallLogDir)) { New-Item -ItemType Directory -Force -Path $InstallLogDir | Out-Null }
        Add-Content -Path $SetupLog -Value $line -Encoding UTF8
    } catch { }
}

function Exit-Fail([string]$Message, [int]$Code = 1) {
    Write-Log "ERROR: $Message"
    Write-Log "FAILED (exit $Code)"
    Start-Sleep -Seconds 5
    exit $Code
}

Write-Log "============================================"
Write-Log "install dir: $InstallDir"
Write-Log "python embed: $PythonEmbed"
Write-Log "PSScriptRoot: $PSScriptRoot"
Write-Log "RepairOnly: $RepairOnly"

trap { Exit-Fail "unhandled exception: $_" 99 }

# 规范化路径，去掉 \\?\ 扩展前缀
if ($InstallDir -match '^\\\?\') { $InstallDir = $InstallDir -replace '^\\\?\', '' }

# --------------- venv 修复 ---------------
function Repair-PyVenvCfg {
    $cfg = Join-Path $VenvDir "pyvenv.cfg"
    if (-not (Test-Path $cfg)) { return }
    if (-not (Test-Path $PythonEmbed)) { return }
    $pythonHome = Split-Path $PythonEmbed
    $version = "3.11.9"
    $versionInfo = "3.11.9.final.0"
    foreach ($line in (Get-Content $cfg -ErrorAction SilentlyContinue)) {
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
    ) | Set-Content -Path $cfg -Encoding ASCII
    Write-Log "repaired pyvenv.cfg -> $pythonHome"
}

# --------------- GPU 检测 ---------------
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
Write-Log "GPU detection: hasNvidia=$hasNvidia"

# --------------- 已有 venv 快速复用 ---------------
if (Test-Path $Marker) {
    if (-not (Test-Path $VenvPython)) {
        Write-Log "marker exists but venv python missing — rebuilding"
        Remove-Item -Force $Marker -ErrorAction SilentlyContinue
    } else {
        Repair-PyVenvCfg
        & $VenvPython -c "import funasr, torch; print('funasr', funasr.__version__, 'torch', torch.__version__)" 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -eq 0) {
            Write-Log "FunASR venv already configured"
            if (-not $RepairOnly) { exit 0 }
        } else {
            Write-Log "venv present but funasr import failed — reinstalling"
            Remove-Item -Force $Marker -ErrorAction SilentlyContinue
        }
    }
}

if ($RepairOnly) {
    Exit-Fail "RepairOnly requested but venv not ready"
}

# --------------- 创建 venv ---------------
if (Test-Path $VenvPython) {
    Write-Log "reusing existing venv"
} else {
    if (-not (Test-Path $PythonEmbed)) {
        Exit-Fail "bundled Python not found: $PythonEmbed"
    }

    Write-Log "creating FunASR virtualenv (network required, ~3-8 min)..."
    New-Item -ItemType Directory -Force -Path (Split-Path $VenvDir) | Out-Null

    $Virtualenv = Join-Path $InstallDir "engines\python\Scripts\virtualenv.exe"
    if (Test-Path $Virtualenv) {
        & $Virtualenv $VenvDir 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) { Exit-Fail "virtualenv.exe failed" }
    } else {
        & $PythonEmbed -m pip install virtualenv 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) { Exit-Fail "pip install virtualenv failed" }
        & $PythonEmbed -m virtualenv $VenvDir 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) { Exit-Fail "virtualenv creation failed" }
    }

    if (-not (Test-Path $VenvPip)) {
        Exit-Fail "venv creation failed: $VenvDir"
    }
}

Repair-PyVenvCfg

# --------------- pip 国内镜像兜底 ---------------
$PipMirrors = @(
    "https://pypi.tuna.tsinghua.edu.cn/simple"
    "https://mirrors.aliyun.com/pypi/simple"
    "https://pypi.mirrors.ustc.edu.cn/simple"
)

function Invoke-PipInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageSpec,
        [string]$ExtraIndex = ""
    )
    $lastError = $null
    $baseArgs = @("install", "--timeout", "180", "--retries", "5")

    # 优先尝试本地 wheel 目录
    if (Test-Path $WheelDir) {
        $wheels = Get-ChildItem -Path $WheelDir -Filter "*.whl" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
        if ($wheels) {
            Write-Log "found local wheels: $($wheels.Count)"
            foreach ($whl in $wheels) {
                Write-Log "pip install local wheel: $(Split-Path $whl -Leaf)"
                & $VenvPip @($baseArgs + @("--no-deps", $whl)) 2>&1 | ForEach-Object { Write-Log $_ }
                if ($LASTEXITCODE -eq 0) { return }
            }
        }
    }

    foreach ($mirror in $PipMirrors) {
        $argList = $baseArgs + @("--index-url", $mirror, $PackageSpec)
        if ($ExtraIndex) {
            $argList += @("--extra-index-url", $ExtraIndex)
        }
        Write-Log "pip install $PackageSpec (mirror=$mirror)"
        try {
            & $VenvPip @argList 2>&1 | ForEach-Object { Write-Log $_ }
            if ($LASTEXITCODE -eq 0) { return }
            $lastError = "pip exit $LASTEXITCODE"
        } catch {
            $lastError = $_
            Write-Log "pip exception: $_"
        }
    }
    Exit-Fail "pip install failed after trying all mirrors: $lastError"
}

# --------------- PyTorch + torchaudio ---------------
Write-Log "installing PyTorch + torchaudio..."
if ($hasNvidia) {
    # 先尝试离线安装已下载的 torch wheel（如果构建机缓存了）
    $torchWheels = Get-ChildItem -Path $WheelDir -Filter "torch*.whl" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    if ($torchWheels) {
        Write-Log "installing torch from local wheels..."
        & $VenvPip install --no-deps $torchWheels 2>&1 | ForEach-Object { Write-Log $_ }
        if ($LASTEXITCODE -ne 0) { Exit-Fail "local torch wheel install failed" }
    } else {
        Invoke-PipInstall -PackageSpec "torch torchaudio" -ExtraIndex "https://download.pytorch.org/whl/cu121"
    }
} else {
    Invoke-PipInstall -PackageSpec "torch torchaudio --index-url https://download.pytorch.org/whl/cpu"
}

# --------------- FunASR 依赖 ---------------
Write-Log "installing FunASR and modelscope..."
if (Test-Path $Req) {
    Invoke-PipInstall -PackageSpec "-r `"$Req`""
} else {
    Invoke-PipInstall -PackageSpec "funasr>=1.1.0 modelscope>=1.15.0"
}

# --------------- sentencepiece 热修 ---------------
$repairSp = Join-Path $InstallDir "scripts\repair-funasr-sentencepiece.ps1"
if (Test-Path $repairSp) {
    Write-Log "running sentencepiece repair..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $repairSp -InstallDir $InstallDir 2>&1 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) { Write-Log "sentencepiece repair returned non-zero, continuing" }
}

# --------------- FFmpeg PATH ---------------
$FfmpegExe = Join-Path $InstallDir "engines\ffmpeg\ffmpeg.exe"
if (Test-Path $FfmpegExe) {
    Write-Log "detected bundled ffmpeg: $FfmpegExe"
    [Environment]::SetEnvironmentVariable("PATH", (Join-Path $InstallDir "engines\ffmpeg") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User"), "User")
}

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

# --------------- 最终校验 ---------------
Write-Log "verifying FunASR import..."
Repair-PyVenvCfg
& $VenvPython -c "import funasr, torch; print('funasr', getattr(funasr,'__version__','?'), 'torch', torch.__version__, 'cuda', torch.version.cuda)" 2>&1 | ForEach-Object { Write-Log $_ }
if ($LASTEXITCODE -ne 0) {
    Exit-Fail "FunASR install verification failed (import funasr)"
}

Set-Content -Path $Marker -Value (Get-Date -Format o) -Encoding UTF8

$asrBackend = if ($hasNvidia) { "funasr-gpu" } else { "funasr-cpu" }
[Environment]::SetEnvironmentVariable("CLIP_ASR_BACKEND", $asrBackend, "User")
[Environment]::SetEnvironmentVariable("CLIP_FUNASR_MODELS_DIR", $ModelsDir, "User")
[Environment]::SetEnvironmentVariable("CLIP_PYTHON", $VenvPython, "User")
[Environment]::SetEnvironmentVariable("CLIP_REPO_ROOT", $InstallDir, "User")

Write-Log "done. backend=$asrBackend"
Write-Log "  CLIP_PYTHON=$VenvPython"
Write-Log "  CLIP_FUNASR_MODELS_DIR=$ModelsDir"
Write-Log "SUCCESS"
