ClipAgent FunASR hotfix (sentencepiece ACCESS_VIOLATION)
1. Quit tray. Extract into ClipAgent ROOT (engines\ same level). Overwrite.
2. Run APPLY-HOTFIX.bat as Admin if possible (VC++ redist silent install).
3. Repair will:
   - clean PATH
   - copy msvcp140/vcruntime beside python + sentencepiece
   - prefer sentencepiece 0.1.99 (no dbghelp), fallback 0.2.2
   - silent-install vc_redist.x64.exe if still failing
4. Success: logs show sentencepiece OK / health gpuReady=true
If still AV: right-click engines\funasr\runtime\vc_redist.x64.exe -> Run as admin, then APPLY again; add ClipAgent folder to AV exclusions.
