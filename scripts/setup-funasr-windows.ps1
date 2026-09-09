# 兼容入口 — 转发到一键安装脚本
param([string]$InstallDir = "")
& "$PSScriptRoot\setup-funasr-bundled.ps1" @PSBoundParameters
