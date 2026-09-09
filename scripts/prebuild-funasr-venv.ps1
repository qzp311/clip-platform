# 打包机专用：预构建 FunASR venv（torch+cu121 + funasr）打进安装包
# 用户机禁止跑本脚本的「下载安装」路径；用户机只用 activate-funasr-engine.ps1
#
# 用法（打包机）:
#   powershell -NoProfile -ExecutionPolicy Bypass -File prebuild-funasr-venv.ps1 -InstallDir "D:\ClipPack.build"

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"
$InstallDir = $InstallDir.TrimEnd('\', '/')
$PythonEmbed = Join-Path $InstallDir "engines\python\python.exe"
$VenvDir = Join-Path $InstallDir "engines\funasr\venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$Marker = Join-Path $VenvDir ".clip-ready"
$Activate = Join-Path $PSScriptRoot "activate-funasr-engine.ps1"

$PipIndex = if ($env:CLIP_PIP_INDEX) { $env:CLIP_PIP_INDEX } else { "https://mirrors.aliyun.com/pypi/simple/" }
$TorchFind = if ($env:CLIP_PYTORCH_INDEX) { $env:CLIP_PYTORCH_INDEX } else { "https://mirrors.aliyun.com/pytorch-wheels/cu121/" }

function Write-Log([string]$Message) {
    Write-Host "clip-prebuild $Message"
}

function Invoke-Native([string]$File, [string[]]$ArgumentList) {
    Write-Log "exec: $File $($ArgumentList -join ' ')"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $File @ArgumentList 2>&1 | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0) { throw "command failed (exit $code): $File" }
}

function Test-TorchOk {
    if (-not (Test-Path $VenvPython)) { return $false }
    $r = & $VenvPython -c "import torch; v=torch.__version__; raise SystemExit(0 if '+cu121' in v else 2)" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Test-FunasrOk {
    if (-not (Test-Path $VenvPython)) { return $false }
    & $VenvPython -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('funasr') else 1)" 2>$null
    return ($LASTEXITCODE -eq 0)
}

Write-Log "InstallDir=$InstallDir"
if (-not (Test-Path $PythonEmbed)) {
    throw "bundled python missing: $PythonEmbed — run download-windows-runtimes.mjs first"
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:PYTHONUNBUFFERED = "1"
$env:PIP_DEFAULT_TIMEOUT = "1000"
$env:PIP_RETRIES = "5"
$env:MODELSCOPE_ENDPOINT = "https://www.modelscope.cn"
$env:HF_ENDPOINT = "https://hf-mirror.com"

if ((Test-TorchOk) -and (Test-FunasrOk)) {
    Write-Log "venv already has torch+funasr — activate only"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Activate -InstallDir $InstallDir
    if ($LASTEXITCODE -ne 0) { throw "activate failed" }
    exit 0
}

# create venv
if (Test-Path $VenvDir) {
    Write-Log "removing incomplete venv"
    Remove-Item -LiteralPath $VenvDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path (Split-Path $VenvDir) | Out-Null
try {
    Invoke-Native $PythonEmbed @("-m", "virtualenv", "--help")
} catch {
    $hostName = ([uri]$PipIndex).Host
    Invoke-Native $PythonEmbed @("-m", "pip", "install", "virtualenv", "-i", $PipIndex, "--trusted-host", $hostName)
}
Invoke-Native $PythonEmbed @("-m", "virtualenv", $VenvDir)

# repair cfg to staging python
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Activate -InstallDir $InstallDir
# activate may fail before packages — ignore, we'll install then activate again
$ErrorActionPreference = "Continue"
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Activate -InstallDir $InstallDir
} catch { Write-Log "pre-activate (expected partial): $($_.Exception.Message)" }
$ErrorActionPreference = "Stop"

# rewrite cfg manually if activate failed early
$cfg = Join-Path $VenvDir "pyvenv.cfg"
$pythonHome = Split-Path $PythonEmbed
@"
home = $pythonHome
implementation = CPython
version_info = 3.11.9.final.0
version = 3.11.9
executable = $PythonEmbed
include-system-site-packages = false
base-prefix = $pythonHome
base-exec-prefix = $pythonHome
base-executable = $PythonEmbed
"@ | Set-Content -Path $cfg -Encoding ASCII

$hostName = ([uri]$PipIndex).Host
$torchHost = ([uri]$TorchFind).Host
Invoke-Native $VenvPython @("-u", "-m", "pip", "install", "--upgrade", "pip", "-i", $PipIndex, "--trusted-host", $hostName)

Write-Log "installing torch==2.5.1+cu121 (China mirror)..."
Invoke-Native $VenvPython @(
    "-u", "-m", "pip", "install",
    "torch==2.5.1+cu121", "torchaudio==2.5.1+cu121",
    "--no-index", "-f", $TorchFind, "--trusted-host", $torchHost,
    "--default-timeout", "1000", "--retries", "5"
)
if (-not (Test-TorchOk)) { throw "torch+cu121 install failed" }

Write-Log "installing funasr + modelscope..."
Invoke-Native $VenvPython @(
    "-u", "-m", "pip", "install",
    "funasr>=1.1.0", "modelscope>=1.15.0",
    "-i", $PipIndex, "--trusted-host", $hostName
)
if (-not (Test-FunasrOk)) { throw "funasr install failed" }

# 删除 modelscope 中体积大且 FunASR 用不到的 CV/NLP 子模块，只保留音频/ASR 相关
Write-Log "trimming modelscope fat modules..."
$fatModules = @(
    "modelscope.models.cv",
    "modelscope.models.nlp",
    "modelscope.models.multi_modal",
    "modelscope.pipelines.cv",
    "modelscope.pipelines.nlp",
    "modelscope.pipelines.multi_modal",
    "modelscope.trainers.cv",
    "modelscope.trainers.nlp",
    "modelscope.trainers.multi_modal",
    "modelscope.metrics",
    "modelscope.preprocessors.cv",
    "modelscope.preprocessors.nlp",
    "modelscope.preprocessors.multi_modal"
)
$site = Join-Path $VenvDir "Lib\site-packages"
foreach ($m in $fatModules) {
    $dir = Join-Path $site ($m -replace '\.', '\')
    if (Test-Path $dir) {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "trimmed $m"
    }
}
# 删除 pycache 减少体积
Get-ChildItem -Path $site -Recurse -Filter "__pycache__" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Activate -InstallDir $InstallDir
if ($LASTEXITCODE -ne 0) { throw "final activate failed" }
if (-not (Test-Path $Marker)) { throw "marker missing after activate" }

Write-Log "prebuild OK: $VenvDir"
exit 0
