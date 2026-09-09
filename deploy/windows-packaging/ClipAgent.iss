; drama-clip 一键安装 — Windows 10/11 x64，GPU/CPU 自动适配
; 构建: .\pack-win.cmd  →  Inno Setup 编译本脚本

#define MyAppName "drama-clip"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "Aiviciking"
#define MyApiBase "http://127.0.0.1:8081"
#ifndef ClipAgentSourceDir
#define ClipAgentSourceDir "output\ClipAgent.build"
#endif
#define SourceDir ClipAgentSourceDir

; 通过命令行参数 MyOutputBaseFilename 覆盖输出文件名，避免被杀毒软件锁死默认名
#ifndef MyOutputBaseFilename
#define MyOutputBaseFilename "ClipAgent-" + MyAppVersion + "-x64"
#endif

#ifndef MyOutputDir
#define MyOutputDir "output"
#endif

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\ClipAgent
DefaultGroupName={#MyAppName}
OutputDir={#MyOutputDir}
OutputBaseFilename={#MyOutputBaseFilename}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
DisableProgramGroupPage=yes
WizardStyle=modern

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[Messages]
chinesesimplified.WelcomeLabel2=此向导将安装「drama-clip」到您的电脑。%n%n安装包已内置 Node.js、Python 与 AI 语音引擎运行依赖，无需您手动配置开发环境。%n%n系统要求：%n• Windows 10 64 位或 Windows 11%n• 任意 Intel/AMD/NVIDIA 显卡（有 NVIDIA 显卡时自动启用 GPU 加速）%n• 可访问互联网（若安装包未预装 AI 引擎，首次约 3–8 分钟自动配置）%n%n点击「下一步」继续。

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\ClipAgent"; Filename: "{app}\clip-agent-desktop.exe"; Comment: "drama-clip · 短剧 AI 智能剪辑平台"
Name: "{userstartup}\ClipAgent"; Filename: "{app}\clip-agent-desktop.exe"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_REPO_ROOT"; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_INSTALL_DIR"; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_API_BASE"; ValueData: "{#MyApiBase}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_ASR_BACKEND"; ValueData: "auto"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_PYTHON"; ValueData: "{app}\engines\funasr\venv\Scripts\python.exe"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "CLIP_FUNASR_MODELS_DIR"; ValueData: "{localappdata}\ClipAgent\models"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\engines\funasr\runtime\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "正在安装 Visual C++ 运行时..."; Check: NeedsVCRedistInstall
Filename: "{app}\clip-agent-desktop.exe"; Description: "立即启动drama-clip"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\ClipAgent\workspace"

[Code]
function IsWindows10OrLater: Boolean;
var
  Version: TWindowsVersion;
begin
  GetWindowsVersionEx(Version);
  Result := Version.Major >= 10;
end;

function IsVCRedistInstalled: Boolean;
var
  RegKey: string;
begin
  // Visual C++ 2015-2022 Redistributable (x64) 14.0 或更高版本
  RegKey := 'SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';
  Result := RegKeyExists(HKLM, RegKey) or RegKeyExists(HKCU, RegKey);
  if not Result then
  begin
    RegKey := 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';
    Result := RegKeyExists(HKLM, RegKey) or RegKeyExists(HKCU, RegKey);
  end;
end;

function NeedsVCRedistInstall: Boolean;
begin
  Result := not IsVCRedistInstalled and FileExists(ExpandConstant('{app}\engines\funasr\runtime\vc_redist.x64.exe'));
end;

function ReadGpuLine: String;
var
  ResultCode: Integer;
  TempFile: String;
  Lines: TArrayOfString;
begin
  Result := '';
  TempFile := ExpandConstant('{tmp}\clip-gpu.txt');
  if Exec('cmd.exe',
    '/c nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits > "' + TempFile + '" 2>nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    if LoadStringsFromFile(TempFile, Lines) and (GetArrayLength(Lines) > 0) then
      Result := Trim(Lines[0]);
  end;
end;

function HasNvidiaGpu: Boolean;
var
  Line: String;
  CommaPos: Integer;
  Name: String;
  VramStr: String;
  VramMb: Integer;
begin
  Result := False;
  Line := ReadGpuLine;
  if Line = '' then
    Exit;

  CommaPos := Pos(',', Line);
  if CommaPos = 0 then
    Exit;

  Name := Trim(Copy(Line, 1, CommaPos - 1));
  VramStr := Trim(Copy(Line, CommaPos + 1, MaxInt));
  VramMb := StrToIntDef(VramStr, 0);

  // 只要有 NVIDIA 显卡且显存 ≥ 4GB 就启用 GPU 加速；不再限定 4060
  if Pos('NVIDIA', UpperCase(Name)) > 0 then
    Result := VramMb >= 4096;
end;

function FunasrVenvReady(const AppDir: String): Boolean;
begin
  Result :=
    FileExists(AppDir + '\engines\funasr\venv\.clip-ready') and
    FileExists(AppDir + '\engines\funasr\venv\Scripts\python.exe');
end;

function SetupLogPath(const AppDir: String): String;
begin
  Result := ExpandConstant('{localappdata}') + '\ClipAgent\logs\funasr-setup.log';
end;

function ReadLastLogLines(const LogPath: String; const MaxLines: Integer): String;
var
  Lines: TArrayOfString;
  Count, I, Start: Integer;
  ResultLines: String;
begin
  Result := '';
  if not FileExists(LogPath) then
    Exit;
  if LoadStringsFromFile(LogPath, Lines) then
  begin
    Count := GetArrayLength(Lines);
    if Count = 0 then
      Exit;
    if Count > MaxLines then
      Start := Count - MaxLines
    else
      Start := 0;
    ResultLines := '';
    for I := Start to Count - 1 do
    begin
      if ResultLines <> '' then
        ResultLines := ResultLines + #13#10;
      ResultLines := ResultLines + Lines[I];
    end;
    Result := ResultLines;
  end;
end;

function RunActivateOrSetup(const AppDir: String): Boolean;
var
  ResultCode: Integer;
  ActivatePath: String;
  SetupPath: String;
  HasNvidia: Boolean;
  AsrBackend: String;
  LogPath: String;
  LogTail: String;
  ErrorMsg: String;
begin
  Result := True;
  if FunasrVenvReady(AppDir) then
    Exit;

  ActivatePath := AppDir + '\scripts\activate-funasr-engine.ps1';
  SetupPath := AppDir + '\scripts\setup-funasr-bundled.ps1';

  if not FileExists(SetupPath) then
  begin
    MsgBox(
      '缺少 AI 环境安装脚本：' + #13#10 + SetupPath + #13#10 + #13#10 +
      '安装包不完整，请重新下载安装程序。',
      mbError, MB_OK);
    Result := False;
    Exit;
  end;

  HasNvidia := HasNvidiaGpu;
  if HasNvidia then
    AsrBackend := 'funasr-gpu'
  else
    AsrBackend := 'funasr-cpu';

  ForceDirectories(ExpandConstant('{localappdata}') + '\ClipAgent\logs');

  // 优先：安装包已预置 venv，只需要离线激活（几秒完成，不联网）
  if FileExists(ActivatePath) and FileExists(AppDir + '\engines\funasr\venv\Scripts\python.exe') then
  begin
    WizardForm.StatusLabel.Caption := '正在激活本地 AI 语音引擎...';
    WizardForm.ProgressGauge.Style := npbstMarquee;

    if Exec(
      'powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ActivatePath + '" -InstallDir "' + AppDir + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      if (ResultCode = 0) and FunasrVenvReady(AppDir) then
        Exit;
    end;

    // 激活失败，降级为联网重新安装
    WizardForm.StatusLabel.Caption := '本地引擎激活失败，正在联网重新配置...';
  end
  else
  begin
    WizardForm.StatusLabel.Caption := '正在配置 AI 语音引擎（' + AsrBackend + '，首次约 3-8 分钟，请保持网络连接）...';
    WizardForm.ProgressGauge.Style := npbstMarquee;
  end;

  if not Exec(
    'powershell.exe',
    '-NoExit -NoProfile -ExecutionPolicy Bypass -File "' + SetupPath + '" -InstallDir "' + AppDir + '"',
    '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('无法启动 AI 环境配置程序。', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if (ResultCode <> 0) or (not FunasrVenvReady(AppDir)) then
  begin
    LogPath := SetupLogPath(AppDir);
    LogTail := ReadLastLogLines(LogPath, 30);
    ErrorMsg := 'AI 语音引擎配置失败（错误码 ' + IntToStr(ResultCode) + '）。' + #13#10 +
                '请检查网络连接后重新运行安装程序。' + #13#10 + #13#10 +
                '日志路径：' + LogPath + #13#10 + #13#10 +
                '最近日志：' + #13#10 + LogTail;
    MsgBox(ErrorMsg, mbError, MB_OK);
    Result := False;
    Exit;
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := True;

  if not IsWindows10OrLater then
  begin
    MsgBox('drama-clip需要 Windows 10 64 位或更高版本。', mbError, MB_OK);
    Result := False;
    Exit;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: String;
  HasNvidia: Boolean;
  AsrBackend: String;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    HasNvidia := HasNvidiaGpu;
    if HasNvidia then
      AsrBackend := 'funasr-gpu'
    else
      AsrBackend := 'funasr-cpu';

    // 根据安装时 GPU 检测结果写入注册表环境变量
    RegWriteExpandStringValue(HKCU, 'Environment', 'CLIP_ASR_BACKEND', AsrBackend);
    if HasNvidia then
      RegWriteExpandStringValue(HKCU, 'Environment', 'CLIP_ASR_DEVICE', 'cuda:0')
    else
      RegWriteExpandStringValue(HKCU, 'Environment', 'CLIP_ASR_DEVICE', 'cpu');

    if not RunActivateOrSetup(AppDir) then
      WizardForm.StatusLabel.Caption := '安装完成，但 AI 引擎未配置成功。启动程序时将自动重试。';
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  if MsgBox('确定要卸载drama-clip吗？' + #13#10 + '工作区临时文件将被清理，设备凭证保留在 AppData 中。', mbConfirmation, MB_YESNO) = IDNO then
    Result := False;
end;
