# 部署可运行的 ClipAgent 桌面端。
# 注意：本机 WDAC 对 LocalMachine(/sm) 签名会按 Enterprise signing level 拦截；
# 必须用 CurrentUser 证书签名（不要 /sm），才能正常启动。
$ErrorActionPreference = "Stop"
$log = "D:\ClipAgent\fix-desktop-sac.log"
function Write-Step($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}
try {
  New-Item -ItemType Directory -Force -Path "D:\ClipAgent" | Out-Null
  "" | Set-Content -Path $log -Encoding UTF8
  Write-Step "start"

  $policyPath = "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy"
  $newExe = "D:\clip-platform\clip-platform\apps\clip-agent-desktop\src-tauri\target\release\clip-agent-desktop.exe"
  $destExe = "D:\ClipAgent\clip-agent-desktop.exe"
  $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"

  if ([Security.Principal.WindowsPrincipal]::new(
      [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Step "关闭 Smart App Control (VerifiedAndReputablePolicyState=0)"
    if (-not (Test-Path $policyPath)) { New-Item -Path $policyPath -Force | Out-Null }
    Set-ItemProperty -Path $policyPath -Name "VerifiedAndReputablePolicyState" -Value 0 -Type DWord -Force
    $state = (Get-ItemProperty $policyPath).VerifiedAndReputablePolicyState
    Write-Step "SAC state now = $state"
    foreach ($p in @(
      "D:\ClipAgent",
      "D:\clip-platform\clip-platform\apps\clip-agent-desktop\src-tauri\target",
      "D:\clip-platform\clip-platform\deploy\windows-packaging\output\ClipAgent"
    )) {
      try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; Write-Step "exclude ok: $p" }
      catch { Write-Step "exclude skip ($p): $($_.Exception.Message)" }
    }
  } else {
    Write-Step "非管理员：跳过 SAC/Defender 写入，仅做 CurrentUser 签名部署"
  }

  if (-not (Test-Path $newExe)) { throw "找不到新版 exe: $newExe" }
  Write-Step "source=$newExe"

  Write-Step "准备 CurrentUser 代码签名证书（禁用 /sm）"
  $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq "CN=ClipAgent Local Dev" -and $_.HasPrivateKey } |
    Select-Object -First 1
  if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=ClipAgent Local Dev" `
      -KeyExportPolicy Exportable -KeySpec Signature -KeyLength 2048 -HashAlgorithm SHA256 `
      -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(5)
    Write-Step "created CurrentUser cert thumbprint=$($cert.Thumbprint)"
  } else {
    Write-Step "reuse CurrentUser cert thumbprint=$($cert.Thumbprint)"
  }

  $work = "D:\ClipAgent\_signed_new.exe"
  Copy-Item -Force $newExe $work
  Write-Step "signing with CurrentUser store..."
  & $signtool sign /fd SHA256 /s My /n "ClipAgent Local Dev" $work
  if ($LASTEXITCODE -ne 0) { throw "signtool failed=$LASTEXITCODE" }
  $sig = Get-AuthenticodeSignature $work
  Write-Step "signature status=$($sig.Status) thumb=$($sig.SignerCertificate.Thumbprint)"

  Get-Process clip-agent-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Copy-Item -Force $work $destExe
  # 同步一份到构建产物，避免下次误用未签名文件
  Copy-Item -Force $work $newExe
  Remove-Item $work -Force -ErrorAction SilentlyContinue
  Write-Step "deployed to $destExe size=$((Get-Item $destExe).Length)"

  $p = Start-Process -FilePath $destExe -WorkingDirectory "D:\ClipAgent" -PassThru
  Start-Sleep -Seconds 3
  if ($p.HasExited) {
    Write-Step "process exited immediately code=$($p.ExitCode)"
    exit 2
  }
  Write-Step "NEW VERSION RUNNING pid=$($p.Id)"
  exit 0
} catch {
  Write-Step ("ERROR: " + $_.Exception.Message)
  exit 1
}
