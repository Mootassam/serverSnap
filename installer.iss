; ServerSnap installers (one script, two apps). Build both: powershell -ExecutionPolicy Bypass -File build.ps1
;   ServerSnap         (admin)     ISCC installer.iss
;   ServerSnap Client  (customer)  ISCC /DCLIENT installer.iss
;
; Windows Smart App Control blocks unsigned programs it does not know. So after installing, only
; programs Windows trusts ever run:
;   - the official Electron runtime, byte-for-byte as released (never modified, renamed or re-iconed)
;   - Windows' own cmd.exe / reg.exe / powershell.exe
; Uninstall goes through electron.exe too (Inno's unins000.exe is unsigned and made at install time).

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#ifdef CLIENT
  #define MyAppName "ServerSnap Client"
  #define MyAppGuid "B8D86232-D366-4B1C-A05B-AD8DA3E13054"
  #define MyAUMID "com.serversnap.client"
  #define MySource "build\client-app"
  #define MyOutput "ServerSnap-Client-Setup"
  #define MyComment "Download your website backups"
#else
  #define MyAppName "ServerSnap"
  #define MyAppGuid "17F51585-C5A8-407A-93BE-00146BCD6EDE"
  #define MyAUMID "com.serversnap.app"
  #define MySource "build\app"
  #define MyOutput "ServerSnap-Setup"
  #define MyComment "Back up, restore and move your VPS"
#endif

[Setup]
AppId={{{#MyAppGuid}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=ServerSnap
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} installer
; per-user install: no administrator prompt, nothing outside this Windows account
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableDirPage=auto
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename={#MyOutput}-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
MinVersion=10.0
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\app\assets\icon.ico
UninstallDisplayName={#MyAppName}
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: checkedonce

[InstallDelete]
; an update replaces the program files completely (settings live elsewhere and are kept)
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\electron"

[Files]
Source: "build\electron\*"; DestDir: "{app}\electron"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#MySource}\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\icon.ico"; Comment: "{#MyComment}"; AppUserModelID: "{#MyAUMID}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\icon.ico"; Comment: "{#MyComment}"; AppUserModelID: "{#MyAUMID}"; Tasks: desktopicon
Name: "{autoprograms}\Uninstall {#MyAppName}"; Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"" --uninstall"; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\icon.ico"; Comment: "Uninstall {#MyAppName}"

[Run]
; load the program once now, so Windows' first security scan happens under the progress bar
; and the app opens quickly afterwards
Filename: "{app}\electron\electron.exe"; Parameters: "--version"; WorkingDir: "{app}"; StatusMsg: "Preparing {#MyAppName}..."; Flags: runhidden waituntilterminated
Filename: "{app}\electron\electron.exe"; Parameters: """{app}\app"""; WorkingDir: "{app}"; Description: "Open {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
{ Stop this app (only copies started from this install folder) so its files can be replaced. }
procedure StopApp();
var
  Rc: Integer;
  Cmd, AppDir: String;
begin
  AppDir := Lowercase(ExpandConstant('{app}'));
  Cmd := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "foreach ($i in 1..2) { Get-Process electron -ErrorAction SilentlyContinue | ' +
         'Where-Object { $_.Path -and $_.Path.ToLower().StartsWith(''' + AppDir + ''') } | ' +
         'Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }"';
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Rc);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopApp();
  Result := '';
end;

{ After installing: point Windows "Apps > Uninstall" at electron.exe --uninstall (Smart App Control would
  block Inno's unsigned unins000.exe), and leave a marker the uninstaller checks before deleting anything. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Key, Exe, AppPath: String;
begin
  if CurStep = ssPostInstall then
  begin
    Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + '{#MyAppGuid}' + '}_is1';
    Exe := ExpandConstant('{app}\electron\electron.exe');
    AppPath := ExpandConstant('{app}\app');
    RegWriteStringValue(HKCU, Key, 'UninstallString', '"' + Exe + '" "' + AppPath + '" --uninstall');
    RegWriteStringValue(HKCU, Key, 'QuietUninstallString', '"' + Exe + '" "' + AppPath + '" --uninstall --quiet');
    RegWriteDWordValue(HKCU, Key, 'NoModify', 1);
    RegWriteDWordValue(HKCU, Key, 'NoRepair', 1);
    SaveStringToFile(ExpandConstant('{app}\serversnap-install.json'),
      '{"app":"{#MyAppName}","version":"{#MyAppVersion}","uninstallKey":"{' + '{#MyAppGuid}' + '}_is1"}', False);
  end;
end;
