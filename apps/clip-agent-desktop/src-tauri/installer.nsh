# drama-clip Windows 安装后钩子
# 安装完成后自动检测 GPU/CPU 并激活 FunASR 环境

!macro NSIS_HOOK_POSTINSTALL
  # 先写安装目录环境变量，供托盘/Agent 查找
  WriteRegStr HKCU "Environment" "CLIP_INSTALL_DIR" "$INSTDIR"
  WriteRegStr HKCU "Environment" "CLIP_REPO_ROOT" "$INSTDIR"
  SendMessage 0xFFFF 0x1A 0 "Environment" /TIMEOUT=3000

  # 静默激活 FunASR（如果安装包带了预置 venv）
  IfFileExists "$INSTDIR\engines\funasr\venv\Scripts\python.exe" 0 post_install_done
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\activate-funasr-engine.ps1"' $0
    DetailPrint "FunASR 激活结果: $0"
  post_install_done:
!macroend
