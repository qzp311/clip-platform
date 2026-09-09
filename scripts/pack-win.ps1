# ClipAgent Windows 打包 — 不依赖终端 PATH 是否已刷新
$ErrorActionPreference = "Stop"

$NodeDir = "C:\Program Files\nodejs"
$Npm = Join-Path $NodeDir "npm.cmd"
$Node = Join-Path $NodeDir "node.exe"

if (-not (Test-Path $Node)) {
  Write-Host "未找到 Node.js，请先安装: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}

$env:Path = "$NodeDir;$env:USERPROFILE\.cargo\bin;$env:Path"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Host "node: $(& $Node -v)" -ForegroundColor Green
Write-Host "npm:  $(& $Npm -v)" -ForegroundColor Green
Write-Host "cwd:  $Root" -ForegroundColor Green
Write-Host ""

& $Npm run pack:win
exit $LASTEXITCODE
