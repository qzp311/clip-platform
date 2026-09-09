# 将最新 clip-agent + 桌面控制台同步到已安装目录（默认 D:\ClipAgent）
$ErrorActionPreference = "Stop"
$InstallDir = if ($env:CLIP_INSTALL_DIR) { $env:CLIP_INSTALL_DIR } else { "D:\ClipAgent" }
$Root = Split-Path $PSScriptRoot -Parent
$env:Path = "C:\Program Files\nodejs;$env:USERPROFILE\.cargo\bin;$env:Path"

Set-Location $Root
Write-Host "[deploy] building clip-agent..." -ForegroundColor Cyan
npm run build -w @clip/clip-agent | Out-Null
Write-Host "[deploy] building desktop..." -ForegroundColor Cyan
npm run build -w @clip/clip-agent-desktop | Out-Null

Write-Host "[deploy] copying clip-agent dist -> $InstallDir\clip-agent\dist" -ForegroundColor Green
Copy-Item -Path "$Root\apps\clip-agent\dist\*" -Destination "$InstallDir\clip-agent\dist\" -Recurse -Force

$clipPackages = @("agent-core", "sdk", "clip-schema", "ffmpeg-templates")
$nmClip = Join-Path $InstallDir "node_modules\@clip"
New-Item -ItemType Directory -Force -Path $nmClip | Out-Null
foreach ($name in $clipPackages) {
  $src = Join-Path $Root "packages\$name"
  if (-not (Test-Path $src)) {
    Write-Warning "skip missing packages/$name"
    continue
  }
  $pkgDest = Join-Path $InstallDir "packages\$name"
  New-Item -ItemType Directory -Force -Path (Split-Path $pkgDest -Parent) | Out-Null
  if (Test-Path $pkgDest) { Remove-Item $pkgDest -Recurse -Force }
  Copy-Item $src $pkgDest -Recurse -Force
  Write-Host "[deploy] updated packages/$name"
  $dest = Join-Path $nmClip $name
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Copy-Item $pkgDest $dest -Recurse -Force
  Write-Host "[deploy] linked @clip/$name"
}

$desktopSrc = "$Root\apps\clip-agent-desktop\src-tauri\target\release\clip-agent-desktop.exe"
$desktopDest = Join-Path $InstallDir "clip-agent-desktop.exe"
if (Test-Path $desktopSrc) {
  try {
    Copy-Item $desktopSrc $desktopDest -Force
    Write-Host "[deploy] updated clip-agent-desktop.exe" -ForegroundColor Green
  } catch {
    Write-Warning "无法覆盖 clip-agent-desktop.exe（请先关闭 ClipAgent 再运行本脚本）"
  }
}

Write-Host "[deploy] done. 请重启 ClipAgent 控制台。" -ForegroundColor Green

$ensureFfmpeg = Join-Path $Root "scripts\ensure-ffmpeg-windows.mjs"
if (Test-Path $ensureFfmpeg) {
  Write-Host "[deploy] ensuring bundled FFmpeg (NVENC)..." -ForegroundColor Cyan
  node $ensureFfmpeg --install-dir $InstallDir
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "[deploy] FFmpeg 自动安装失败，请手动运行: node scripts\ensure-ffmpeg-windows.mjs --install-dir $InstallDir"
  }
}
