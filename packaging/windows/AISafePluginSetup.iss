#include "..\..\dist\windows-installer\metadata.iss"

[Setup]
AppId={{9FE95A8B-93AB-43B7-8B61-5C9AEB3910AB}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}
AppUpdatesURL={#MyAppUrl}
AppCopyright={#MyAppCopyright}
DefaultDirName={localappdata}\AI-Safe-Plugin
DefaultGroupName=AI-Safe Plugin
DisableProgramGroupPage=yes
DisableDirPage=no
DisableWelcomePage=no
ChangesAssociations=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchiveExtraction=full
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
LicenseFile=..\..\LICENSE
SetupIconFile=..\..\dist\windows-installer\ai-safe-plugin.ico
WizardImageFile=assets\ai-safe-plugin-wizard.bmp
WizardSmallImageFile=assets\ai-safe-plugin-wizard-small.bmp
OutputDir=..\..\dist
OutputBaseFilename=AISafePluginSetup-{#MyAppVersion}
UninstallDisplayName=AI-Safe Plugin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#MyStageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\windows-installer\ai-safe-plugin.ico"; DestDir: "{app}\.runtime"; DestName: "ai-safe-plugin.ico"; Flags: ignoreversion

[Dirs]
Name: "{app}\.runtime"
Name: "{app}\.runtime\cache"
Name: "{app}\.runtime\cache\model"
Name: "{app}\.runtime\cache\hf"
Name: "{app}\.runtime\cache\hf\hub"
Name: "{app}\.runtime\cache\hf\transformers"
Name: "{app}\.runtime\cache\xdg"

[Icons]
Name: "{autoprograms}\AI-Safe Plugin"; Filename: "{uninstallexe}"; IconFilename: "{app}\.runtime\ai-safe-plugin.ico"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.runtime"
Type: files; Name: "{app}\.env"

[Code]
var
  DownloadPage: TDownloadWizardPage;
  ExtractionPage: TExtractionWizardPage;
  ExtensionIds: String;

function GetCliExtensionIds(): String;
var
  MultiIds: String;
  SingleId: String;
begin
  MultiIds := Trim(ExpandConstant('{param:EXTENSION_IDS|}'));
  if MultiIds = '' then
    MultiIds := Trim(ExpandConstant('{param:ExtensionIds|}'));

  SingleId := Trim(ExpandConstant('{param:EXTENSION_ID|}'));
  if SingleId = '' then
    SingleId := Trim(ExpandConstant('{param:ExtensionId|}'));

  if (MultiIds <> '') and (SingleId <> '') then
    Result := MultiIds + ',' + SingleId
  else if MultiIds <> '' then
    Result := MultiIds
  else
    Result := SingleId;
end;

function ResolveExtensionIds(): String;
var
  CliExtensionIds: String;
begin
  CliExtensionIds := GetCliExtensionIds();
  if CliExtensionIds <> '' then
    Result := CliExtensionIds + ',{#MyDefaultExtensionId}'
  else
    Result := '{#MyDefaultExtensionId}';
end;

function ModelFilesPresentInDir(const Value: String): Boolean;
var
  ModelDir: String;
begin
  ModelDir := AddBackslash(Value);
  Result :=
    DirExists(Value) and
    FileExists(ModelDir + 'config.json') and
    FileExists(ModelDir + 'gliner2_config.json');
end;

function BundledModelPresent(): Boolean;
begin
  Result := ModelFilesPresentInDir(ExpandConstant('{app}\.runtime\cache\model\model'));
end;

function CachedHubModelPresent(): Boolean;
var
  SnapshotsDir: String;
  SnapshotPath: String;
  FindRec: TFindRec;
begin
  Result := False;
  SnapshotsDir := ExpandConstant('{app}\.runtime\cache\hf\hub\models--lmo3--gliner2-large-v1-onnx\snapshots');
  if not DirExists(SnapshotsDir) then
    exit;

  if FindFirst(AddBackslash(SnapshotsDir) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          SnapshotPath := AddBackslash(SnapshotsDir) + FindRec.Name;
          if ModelFilesPresentInDir(SnapshotPath) then
          begin
            Result := True;
            exit;
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsModelPresent(): Boolean;
begin
  Result := BundledModelPresent() or CachedHubModelPresent();
end;

function GetModelArchivePath(): String;
begin
  Result := ExpandConstant('{tmp}\{#MyModelAssetName}');
end;

function GetTemporaryExtractDir(): String;
begin
  Result := ExpandConstant('{tmp}\ai-safe-plugin-model-stage');
end;

function GetExtractedTarPath(): String;
begin
  Result := AddBackslash(GetTemporaryExtractDir()) + 'ai-safe-plugin-model-fp16.tar';
end;

procedure DownloadModelAsset();
begin
  if WizardSilent then
  begin
    DownloadTemporaryFile('{#MyModelAssetUrl}', '{#MyModelAssetName}', '', nil);
    exit;
  end;

  DownloadPage.Clear;
  DownloadPage.Add('{#MyModelAssetUrl}', '{#MyModelAssetName}', '');
  DownloadPage.Show;
  try
    DownloadPage.Download;
  finally
    DownloadPage.Hide;
  end;
end;

procedure ExtractModelAsset();
var
  TempExtractDir: String;
begin
  TempExtractDir := GetTemporaryExtractDir();
  if not DirExists(TempExtractDir) then
    CreateDir(TempExtractDir);

  if WizardSilent then
  begin
    ExtractArchive(GetModelArchivePath(), TempExtractDir, '', True, nil);
    ExtractArchive(GetExtractedTarPath(), ExpandConstant('{app}\.runtime\cache\model'), '', True, nil);
    exit;
  end;

  ExtractionPage.Clear;
  ExtractionPage.ShowArchiveInsteadOfFile := True;
  ExtractionPage.Add(GetModelArchivePath(), TempExtractDir, True);
  ExtractionPage.Show;
  try
    ExtractionPage.Extract;
  finally
    ExtractionPage.Hide;
  end;

  ExtractionPage.Clear;
  ExtractionPage.ShowArchiveInsteadOfFile := True;
  ExtractionPage.Add(GetExtractedTarPath(), ExpandConstant('{app}\.runtime\cache\model'), True);
  ExtractionPage.Show;
  try
    ExtractionPage.Extract;
  finally
    ExtractionPage.Hide;
  end;
end;

procedure EnsureModelPresent();
begin
  if IsModelPresent() then
    exit;

  try
    DownloadModelAsset();
    ExtractModelAsset();
  except
    RaiseException(
      'AI-Safe Plugin could not download the GLiNER2 model from this release. ' +
      'Check your network connection and rerun setup.'
    );
  end;

  if not IsModelPresent() then
    RaiseException('AI-Safe Plugin setup could not verify the downloaded GLiNER2 model cache.');
end;

procedure InitializeWizard();
begin
  DownloadPage := CreateDownloadPage(
    'Downloading GLiNER2 model',
    'AI-Safe Plugin is downloading the local model asset from this release.',
    nil
  );
  DownloadPage.ShowBaseNameInsteadOfUrl := True;

  ExtractionPage := CreateExtractionPage(
    'Extracting GLiNER2 model',
    'AI-Safe Plugin is unpacking the downloaded model into your local cache.',
    nil
  );

end;

procedure FinalizeLocalRuntime();
var
  ResultCode: Integer;
  InstallerScript: String;
  Params: String;
begin
  ExtensionIds := ResolveExtensionIds();
  if ExtensionIds = '' then
    RaiseException('A valid AI-Safe Plugin extension ID is required to finish Windows setup. Pass /EXTENSION_ID=<id>, /EXTENSION_IDS=<ids>, or rebuild with a valid pinned key.');

  InstallerScript := ExpandConstant('{app}\scripts\installers\install.ps1');
  if not FileExists(InstallerScript) then
    RaiseException('AI-Safe Plugin setup could not find the bundled Windows installer script.');

  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File "' + InstallerScript + '"' +
    ' -ExtensionIds "' + ExtensionIds + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '"' +
    ' -UseExistingBundle';

  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Failed to launch AI-Safe Plugin runtime provisioning.');
  if ResultCode <> 0 then
    RaiseException('AI-Safe Plugin runtime provisioning failed with exit code ' + IntToStr(ResultCode) + '.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    EnsureModelPresent();
    FinalizeLocalRuntime();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  NativeHostUninstall: String;
  AutostartUninstall: String;
  CmdParams: String;
begin
  if CurUninstallStep <> usUninstall then
    exit;

  NativeHostUninstall := ExpandConstant('{app}\server\native-host\uninstall_windows.bat');
  if FileExists(NativeHostUninstall) then
  begin
    CmdParams := '/C ""' + NativeHostUninstall + '""';
    Exec(ExpandConstant('{cmd}'), CmdParams, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  AutostartUninstall := ExpandConstant('{app}\server\autostart\uninstall_windows.bat');
  if FileExists(AutostartUninstall) then
  begin
    CmdParams := '/C ""' + AutostartUninstall + '""';
    Exec(ExpandConstant('{cmd}'), CmdParams, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
