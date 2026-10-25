#define MyAppName "系统监控"
#ifndef MyAppVersion
  #define MyAppVersion "1.2.2"
#endif
#ifndef MyArchitecture
  #define MyArchitecture "x64compatible"
#endif
#define MyAppPublisher "金将军的迈巴赫保养员"
#define MyAppExeName "SystemMonitor.exe"

[Setup]
AppId={{8F1D4E2A-6C3B-4A9D-9D2E-6B7A1C5F3E80}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/3311650060a-bot
AppSupportURL=https://github.com/3311650060a-bot/SystemMonitor_webUI/issues
AppUpdatesURL=https://github.com/3311650060a-bot/SystemMonitor_webUI/releases
DefaultDirName={localappdata}\Programs\SystemMonitor
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=SystemMonitor-Setup-{#MyAppVersion}
SetupIconFile=assets\SystemMonitor.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed={#MyArchitecture}
MinVersion=10.0
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
DirExistsWarning=no
SetupLogging=yes
LanguageDetectionMethod=uilanguage
ShowLanguageDialog=auto
LicenseFile=..\LICENSE
DisableWelcomePage=no
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright={#MyAppPublisher} - MIT License
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "..\build\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\gpu.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tray.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\node\node.exe"; DestDir: "{app}\runtime\node"; Flags: ignoreversion
Source: "..\build\node\LICENSE"; DestDir: "{app}\runtime\node"; Flags: ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppName} - 实时性能监控"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppName} - 实时性能监控"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动系统监控"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopServer"

[UninstallDelete]
Type: files; Name: "{app}\server.log"
Type: files; Name: "{app}\server.err.log"
Type: files; Name: "{app}\launcher.log"

[Code]
procedure InitializeWizard();
var
  PublisherInfoText: TNewStaticText;
begin
  PublisherInfoText := TNewStaticText.Create(WizardForm);
  PublisherInfoText.Parent := WizardForm.WelcomeLabel2.Parent;
  PublisherInfoText.Align := alBottom;
  PublisherInfoText.AutoSize := False;
  PublisherInfoText.WordWrap := True;
  PublisherInfoText.Height := ScaleY(46);
  PublisherInfoText.Font.Color := clGray;
  if ActiveLanguage = 'chinesesimplified' then
    PublisherInfoText.Caption :=
      '发行商：金将军的迈巴赫保养员' + #13#10 +
      '项目主页：https://github.com/3311650060a-bot' + #13#10 +
      '开源协议：MIT License'
  else
    PublisherInfoText.Caption :=
      'Publisher: 金将军的迈巴赫保养员' + #13#10 +
      'Homepage: https://github.com/3311650060a-bot' + #13#10 +
      'License: MIT';
end;

procedure StopInstalledApp();
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\{#MyAppExeName}')) then
    Exec(ExpandConstant('{app}\{#MyAppExeName}'), '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    StopInstalledApp();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'SystemMonitor');
end;
