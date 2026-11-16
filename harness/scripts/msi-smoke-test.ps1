<#
.SYNOPSIS
  Installs the harness MSI silently, runs the installed app's self-check, and
  uninstalls it, checking the result of each step.

.DESCRIPTION
  The harness-msi workflow runs this on a Windows runner after it builds the
  MSI, so a broken installer is caught before a person tries it. It can also
  be run by hand on a Windows machine that does not have the harness
  installed:

    powershell -ExecutionPolicy Bypass -File scripts\msi-smoke-test.ps1 -MsiPath "C:\path\to\DOE Oracle Test Harness-0.2.0-x64.msi"

  Steps (run one with -Step, or all in order):
    install     msiexec /i /qn, then checks the program files, shortcuts, and
                Apps entry are there.
    self-check  runs the installed exe with --self-check, with a time limit,
                and reads its report (questions file, SQLite, bundled Chromium).
    uninstall   msiexec /x /qn, then checks the program files, shortcuts, and
                Apps entry are gone and the per-user data folder is kept.

  It contacts no outside site. Logs and the self-check report are collected
  in -OutDir. Works in Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$MsiPath,
  [ValidateSet('all', 'install', 'self-check', 'uninstall')][string]$Step = 'all',
  [string]$OutDir = (Join-Path $env:TEMP 'harness-msi-smoke'),
  # When given, the installed app must report exactly this version.
  [string]$ExpectedVersion = '',
  [int]$InstallTimeoutSeconds = 600,
  [int]$SelfCheckTimeoutSeconds = 240,
  [int]$UninstallTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = 'DOE Oracle Test Harness'
$ExeName = "$ProductName.exe"
# Electron's per-user data folder: harness.db, the Copilot profile, pending-writes.jsonl.
$UserDataDir = Join-Path $env:APPDATA $ProductName
$ReportPath = Join-Path (Join-Path $UserDataDir 'self-check') 'report.json'
$StatePath = Join-Path $OutDir 'state.json'
$RequiredChecks = @('questions', 'sqlite', 'browser')

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message"
}

function Add-Summary([string]$Markdown) {
  if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Markdown -Encoding utf8
  }
}

function Read-State {
  if (Test-Path -LiteralPath $StatePath) {
    return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  }
  return $null
}

function Save-State($State) {
  $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
}

function Get-StateValue($State, [string]$Name, $Default) {
  if ($null -ne $State -and $null -ne $State.PSObject.Properties[$Name]) {
    return $State.$Name
  }
  return $Default
}

# Runs msiexec with a time limit and a verbose log, and fails on any exit
# code other than success (0) or success-restart-needed (3010).
function Invoke-Msiexec([string]$Arguments, [string]$LogName, [int]$TimeoutSeconds) {
  $log = Join-Path $OutDir $LogName
  $all = "$Arguments /qn /norestart /l*v `"$log`""
  Write-Host "msiexec $all"
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $all -PassThru
  $null = $process.Handle # keeps ExitCode readable after the process ends
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    throw "msiexec did not finish within $TimeoutSeconds seconds. See $log"
  }
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "msiexec exited with code $($process.ExitCode). See $log"
  }
  Write-Host "msiexec exited with code $($process.ExitCode)"
}

# The Apps (Add or remove programs) entries for the harness, per-user and per-machine.
function Get-UninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $found = @()
  foreach ($root in $roots) {
    $items = @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
      $name = $item.PSObject.Properties['DisplayName']
      if ($null -ne $name -and $name.Value -eq $ProductName) {
        $found += $item
      }
    }
  }
  return , $found
}

function Get-ShortcutPaths {
  $folders = @(
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms'),
    [Environment]::GetFolderPath('DesktopDirectory'),
    [Environment]::GetFolderPath('CommonDesktopDirectory')
  )
  $found = @()
  foreach ($folder in $folders) {
    if ($folder) {
      $path = Join-Path $folder "$ProductName.lnk"
      if (Test-Path -LiteralPath $path) { $found += $path }
    }
  }
  return , $found
}

# Where the MSI put the app. A per-user install goes under
# %LOCALAPPDATA%\Programs; the other folders cover a per-machine install.
function Find-InstallDir {
  $candidates = @(
    (Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') $ProductName),
    (Join-Path $env:ProgramFiles $ProductName)
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} $ProductName)
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate $ExeName)) { return $candidate }
  }
  # Fall back to where a shortcut points.
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in (Get-ShortcutPaths)) {
    $target = $shell.CreateShortcut($shortcut).TargetPath
    if ($target -and (Test-Path -LiteralPath $target)) { return (Split-Path -Parent $target) }
  }
  return $null
}

# Processes started from the install folder: the app itself and its bundled Chromium.
function Get-InstalledProcesses([string]$InstallDir) {
  $found = @()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $process.Path } catch { $path = $null }
    if ($path -and $path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
      $found += $process
    }
  }
  return , $found
}

function Invoke-InstallStep {
  Write-Step "Install $MsiPath"
  $existing = Get-UninstallEntries
  if ($existing.Count -gt 0) {
    throw "$ProductName is already installed (version $($existing[0].DisplayVersion)). Uninstall it first: this test needs a machine without the harness."
  }
  $userDataExisted = Test-Path -LiteralPath $UserDataDir
  $harnessDbExisted = Test-Path -LiteralPath (Join-Path $UserDataDir 'harness.db')
  Write-Host "Per-user data folder before install: $UserDataDir (exists: $userDataExisted)"

  Invoke-Msiexec "/i `"$MsiPath`"" 'msi-install.log' $InstallTimeoutSeconds

  $installDir = Find-InstallDir
  if (-not $installDir) {
    throw "The installer finished but $ExeName was not found under %LOCALAPPDATA%\Programs or Program Files."
  }
  Write-Host "Installed to: $installDir"

  $resources = Join-Path $installDir 'resources'
  $manifestPath = Join-Path (Join-Path $resources 'browser') 'browser.json'
  $required = @(
    (Join-Path $installDir $ExeName),
    (Join-Path $resources 'app.asar'),
    (Join-Path (Join-Path $resources 'config') 'questions.json'),
    $manifestPath
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing from the install: $path" }
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $browserDir = Join-Path $resources 'browser'
  $browserExe = Join-Path $browserDir ($manifest.executable -replace '/', '\')
  if (-not (Test-Path -LiteralPath $browserExe)) { throw "The bundled browser is missing: $browserExe" }
  foreach ($notice in @($manifest.notices)) {
    $noticePath = Join-Path $browserDir ($notice -replace '/', '\')
    if (-not (Test-Path -LiteralPath $noticePath)) { throw "The browser's notice file is missing: $noticePath" }
  }
  Write-Host "Bundled browser: Chromium $($manifest.browserVersion) (Playwright $($manifest.playwrightVersion), revision $($manifest.revision))"

  $entries = Get-UninstallEntries
  if ($entries.Count -ne 1) { throw "Expected one Apps entry for $ProductName, found $($entries.Count)." }
  $displayVersion = $entries[0].DisplayVersion
  $perUser = $entries[0].PSPath -like '*HKEY_CURRENT_USER*'
  Write-Host "Apps entry: $ProductName $displayVersion (per-user: $perUser)"

  $shortcuts = Get-ShortcutPaths
  $shortcuts | ForEach-Object { Write-Host "Shortcut: $_" }
  if ($shortcuts.Count -lt 2) { throw "Expected a Start menu shortcut and a desktop shortcut, found $($shortcuts.Count)." }

  $files = @(Get-ChildItem -LiteralPath $installDir -Recurse -File)
  $installedBytes = ($files | Measure-Object -Property Length -Sum).Sum
  $installedMb = [math]::Round($installedBytes / 1MB, 1)
  $msiBytes = (Get-Item -LiteralPath $MsiPath).Length
  $msiMb = [math]::Round($msiBytes / 1MB, 1)
  Write-Host "Installed size: $installedMb MB in $($files.Count) files. MSI size: $msiMb MB ($msiBytes bytes)."

  $running = Get-InstalledProcesses $installDir
  if ($running.Count -gt 0) { throw "A silent install must not start the app, but $($running.Count) process(es) are running from $installDir." }

  Save-State ([pscustomobject]@{
      installDir          = $installDir
      displayVersion      = $displayVersion
      perUser             = $perUser
      userDataExisted     = $userDataExisted
      harnessDbExisted    = $harnessDbExisted
      selfCheckRan        = $false
    })
  Add-Summary "### MSI install`n`n- MSI: ``$(Split-Path -Leaf $MsiPath)``, $msiMb MB ($msiBytes bytes)`n- Installed to ``$installDir`` (per-user: $perUser), $installedMb MB in $($files.Count) files`n- Apps entry version: $displayVersion`n- Bundled browser: Chromium $($manifest.browserVersion), Playwright $($manifest.playwrightVersion)`n"
  Write-Host 'PASS: install'
}

function Invoke-SelfCheckStep {
  Write-Step 'Run the installed app with --self-check'
  $state = Read-State
  $installDir = Get-StateValue $state 'installDir' $null
  if (-not $installDir) { $installDir = Find-InstallDir }
  if (-not $installDir) { throw "$ProductName is not installed." }
  $exe = Join-Path $installDir $ExeName

  if (Test-Path -LiteralPath $ReportPath) { Remove-Item -LiteralPath $ReportPath -Force }
  Write-Host "`"$exe`" --self-check"
  $process = Start-Process -FilePath $exe -ArgumentList '--self-check' -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit($SelfCheckTimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    foreach ($left in (Get-InstalledProcesses $installDir)) { Stop-Process -Id $left.Id -Force -ErrorAction SilentlyContinue }
    throw "The self-check did not exit within $SelfCheckTimeoutSeconds seconds and was stopped."
  }
  $exitCode = $process.ExitCode
  Write-Host "Self-check exit code: $exitCode (0 passed, 1 failed, 2 timed out)"

  if (-not (Test-Path -LiteralPath $ReportPath)) {
    throw "The self-check wrote no report at $ReportPath (exit code $exitCode)."
  }
  Copy-Item -LiteralPath $ReportPath -Destination (Join-Path $OutDir 'self-check-report.json') -Force
  $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
  Write-Host "Report: $($report.app.name) $($report.app.version), packaged: $($report.app.packaged), status: $($report.status)"
  Write-Host "Per-user data folder: $($report.app.userDataDir)"

  $summary = "### Self-check of the installed app`n`n$($report.app.name) $($report.app.version), status **$($report.status)**, exit code $exitCode`n`n| Check | Result | Time (ms) | Detail |`n| --- | --- | --- | --- |`n"
  foreach ($check in @($report.checks)) {
    $result = 'FAIL'
    if ($check.ok) { $result = 'pass' }
    Write-Host ("  [{0}] {1} ({2} ms): {3}" -f $result, $check.name, $check.durationMs, $check.detail)
    $summary += "| $($check.name) | $result | $($check.durationMs) | $($check.detail -replace '\|', '/') |`n"
  }
  Add-Summary $summary

  $problems = @()
  if ($exitCode -ne 0) { $problems += "exit code $exitCode" }
  if (-not $report.ok) { $problems += "the report says status $($report.status)" }
  if (-not $report.app.packaged) { $problems += 'the report is not from a packaged app' }
  if ($ExpectedVersion -and $report.app.version -ne $ExpectedVersion) {
    $problems += "the app reports version $($report.app.version), expected $ExpectedVersion"
  }
  if ($report.app.userDataDir -ne $UserDataDir) {
    $problems += "the app's data folder is $($report.app.userDataDir), expected $UserDataDir"
  }
  foreach ($name in $RequiredChecks) {
    $check = @($report.checks) | Where-Object { $_.name -eq $name }
    if (-not $check) { $problems += "the '$name' check did not run" }
    elseif (-not $check.ok) { $problems += "the '$name' check failed: $($check.detail)" }
  }
  $browser = @($report.checks) | Where-Object { $_.name -eq 'browser' }
  if ($browser -and $browser.ok -and ($browser.detail.IndexOf($installDir, [StringComparison]::OrdinalIgnoreCase) -lt 0)) {
    $problems += "the browser that launched is not the one under $installDir"
  }
  # The self-check uses a scratch database and must leave real data alone.
  if (Test-Path -LiteralPath (Join-Path $UserDataDir 'self-check.db')) { $problems += 'self-check.db was left behind' }
  $harnessDb = Join-Path $UserDataDir 'harness.db'
  if (-not (Get-StateValue $state 'harnessDbExisted' $true) -and (Test-Path -LiteralPath $harnessDb)) {
    $problems += 'the self-check created harness.db; it must not open the real database'
  }

  # Nothing from the install folder may keep running: it would block the uninstall.
  $deadline = (Get-Date).AddSeconds(15)
  $left = Get-InstalledProcesses $installDir
  while ($left.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $left = Get-InstalledProcesses $installDir
  }
  if ($left.Count -gt 0) {
    $names = ($left | ForEach-Object { "$($_.ProcessName) ($($_.Id))" }) -join ', '
    foreach ($process in $left) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    $problems += "processes were still running from the install folder after the self-check: $names"
  }

  if ($null -ne $state) {
    $state.selfCheckRan = $true
    Save-State $state
  }
  if ($problems.Count -gt 0) {
    throw ("Self-check failed: " + ($problems -join '; '))
  }
  Write-Host 'PASS: self-check'
}

function Invoke-UninstallStep {
  Write-Step "Uninstall $ProductName"
  $state = Read-State
  $installDir = Get-StateValue $state 'installDir' $null
  if (-not $installDir) { $installDir = Find-InstallDir }
  if (-not $installDir) { throw "$ProductName is not installed, so there is nothing to uninstall." }

  Invoke-Msiexec "/x `"$MsiPath`"" 'msi-uninstall.log' $UninstallTimeoutSeconds

  $problems = @()
  if (Test-Path -LiteralPath $installDir) {
    $remaining = @(Get-ChildItem -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue)
    Write-Host "Left in $installDir after uninstall ($($remaining.Count) items):"
    $remaining | Select-Object -First 50 | ForEach-Object { Write-Host "  $($_.FullName)" }
    $problems += "the program folder $installDir still exists, with $($remaining.Count) item(s)"
  }
  else {
    Write-Host "Program folder removed: $installDir"
  }
  $entries = Get-UninstallEntries
  if ($entries.Count -gt 0) { $problems += 'the Apps entry is still there' } else { Write-Host 'Apps entry removed.' }
  $shortcuts = Get-ShortcutPaths
  if ($shortcuts.Count -gt 0) { $problems += "shortcuts are still there: $($shortcuts -join ', ')" } else { Write-Host 'Shortcuts removed.' }

  # Documented behavior (harness/README.md, "What uninstall leaves behind"):
  # uninstall keeps the per-user data folder, so results survive a reinstall.
  $kept = @()
  if (Test-Path -LiteralPath $UserDataDir) {
    $kept = @(Get-ChildItem -LiteralPath $UserDataDir -Force | ForEach-Object { $_.Name })
    Write-Host "Kept, as documented: $UserDataDir"
    $kept | ForEach-Object { Write-Host "  $_" }
  }
  if (Get-StateValue $state 'selfCheckRan' $false) {
    if (-not (Test-Path -LiteralPath $ReportPath)) {
      $problems += "the per-user data folder was not kept: $ReportPath is gone"
    }
  }
  Add-Summary "### Uninstall`n`n- Program folder, Apps entry, and shortcuts removed: $($problems.Count -eq 0)`n- Per-user data folder kept at ``$UserDataDir``: $(Test-Path -LiteralPath $UserDataDir) ($($kept.Count) items)`n"

  if ($problems.Count -gt 0) {
    throw ("Uninstall check failed: " + ($problems -join '; '))
  }
  Write-Host 'PASS: uninstall'
}

try {
  $MsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Write-Host "MSI: $MsiPath"
  Write-Host "Logs and report: $OutDir"

  if ($Step -eq 'all' -or $Step -eq 'install') { Invoke-InstallStep }
  if ($Step -eq 'all' -or $Step -eq 'self-check') { Invoke-SelfCheckStep }
  if ($Step -eq 'all' -or $Step -eq 'uninstall') { Invoke-UninstallStep }
}
catch {
  Write-Host ''
  Write-Host "FAIL: $($_.Exception.Message)"
  Add-Summary "`n**FAIL:** $($_.Exception.Message)`n"
  exit 1
}
exit 0
