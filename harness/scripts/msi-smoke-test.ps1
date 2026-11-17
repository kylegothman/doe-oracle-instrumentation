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
                Then runs it once more with the browser check's limit set to
                1 ms, so that check always times out, and checks nothing from
                the install folder is left running.
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
  [int]$SelfCheckTimeoutSeconds = 300,
  [int]$UninstallTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = 'DOE Oracle Test Harness'
$ExeName = "$ProductName.exe"
# Electron's per-user data folder: harness.db, the Copilot profile, pending-writes.jsonl.
$UserDataDir = Join-Path $env:APPDATA $ProductName
$ReportPath = Join-Path (Join-Path $UserDataDir 'self-check') 'report.json'
# The scratch browser profile the self-check launches on and removes.
$ScratchProfileDir = Join-Path (Join-Path $UserDataDir 'self-check') 'profile'
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

# Runs the installed app with --self-check and the given extra arguments,
# with a time limit, and returns its exit code.
function Invoke-SelfCheckRun([string]$Exe, [string]$InstallDir, [string]$Arguments) {
  Write-Host "`"$Exe`" $Arguments"
  $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit($SelfCheckTimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    foreach ($left in (Get-InstalledProcesses $InstallDir)) { Stop-Process -Id $left.Id -Force -ErrorAction SilentlyContinue }
    throw "The self-check did not exit within $SelfCheckTimeoutSeconds seconds and was stopped."
  }
  return $process.ExitCode
}

# Nothing from the install folder may keep running after the app exits: it
# would block the uninstall. Windows can take a moment to end a process tree,
# so what is still there after 15 seconds counts. Returns the problems found.
function Test-NothingLeftRunning([string]$InstallDir, [string]$After) {
  $left = Get-InstalledProcesses $InstallDir
  Write-Host "Processes from the install folder right after $After exited: $($left.Count)"
  $deadline = (Get-Date).AddSeconds(15)
  while ($left.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $left = Get-InstalledProcesses $InstallDir
  }
  if ($left.Count -eq 0) { return , @() }
  $names = ($left | ForEach-Object { "$($_.ProcessName) ($($_.Id))" }) -join ', '
  foreach ($process in $left) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  return , @("processes were still running from the install folder 15 seconds after ${After}: $names")
}

# The report's own account of whether the app closed every browser it started
# before it exited. Returns the problems found.
function Test-ReportedCleanup($Report, [string]$Run) {
  $cleanup = $Report.PSObject.Properties['cleanup']
  if ($null -eq $cleanup) { return , @("the report of $Run does not say whether its browsers were closed (no 'cleanup' field)") }
  Write-Host "Report of ${Run}: closed everything it started before exiting: $($cleanup.Value.ok)"
  if (-not $cleanup.Value.ok) { return , @("$Run did not close everything it started: $($cleanup.Value.problem)") }
  return , @()
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
  # A per-user install puts the program under the user's own folder. Where
  # Windows keeps the Apps entry is printed for the record.
  $perUser = $installDir.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)
  $entryKey = "$($entries[0].PSPath)" -replace '^.*::', ''
  Write-Host "Apps entry: $ProductName $displayVersion"
  Write-Host "Apps entry key: $entryKey"
  Write-Host "Per-user install: $perUser"

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

# Runs the self-check with the browser check's limit at 1 ms. Launching a
# browser always takes longer than that, so the check always times out while
# its launch is still under way. The run must still exit by itself, report
# the timeout, say it closed what it started, and leave no browser running.
# Returns the problems found.
#
# Before the app closed its browsers itself (issue #72), this run already
# left nothing behind on the runner: the browser was gone within a second of
# the app exiting. So the process check alone cannot tell the two apart; the
# report's 'cleanup' field can.
function Invoke-TimedOutSelfCheck([string]$Exe, [string]$InstallDir) {
  Write-Step 'Run the self-check with a browser limit of 1 ms'
  $timeoutReport = Join-Path $OutDir 'self-check-timeout-report.json'
  if (Test-Path -LiteralPath $timeoutReport) { Remove-Item -LiteralPath $timeoutReport -Force }
  $started = Get-Date
  $exitCode = Invoke-SelfCheckRun $Exe $InstallDir "--self-check --self-check-browser-timeout-ms=1 `"--self-check-out=$timeoutReport`""
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Write-Host "Exit code: $exitCode after $seconds s (1 expected: a check failed)"

  $problems = @()
  $problems += Test-NothingLeftRunning $InstallDir 'the timed-out self-check'
  if (Test-Path -LiteralPath $ScratchProfileDir) { $problems += "the timed-out self-check left its scratch browser profile at $ScratchProfileDir" }
  if ($exitCode -ne 1) { $problems += "the timed-out self-check exited with code $exitCode, expected 1" }

  $detail = 'no report'
  if (-not (Test-Path -LiteralPath $timeoutReport)) {
    $problems += "the timed-out self-check wrote no report at $timeoutReport"
  }
  else {
    $report = Get-Content -LiteralPath $timeoutReport -Raw | ConvertFrom-Json
    $problems += Test-ReportedCleanup $report 'the timed-out self-check'
    $browser = @($report.checks) | Where-Object { $_.name -eq 'browser' }
    if (-not $browser) { $problems += "the timed-out self-check's report has no 'browser' check" }
    else {
      $detail = $browser.detail
      Write-Host ("  [browser] ok: {0} ({1} ms): {2}" -f $browser.ok, $browser.durationMs, $browser.detail)
      if ($browser.ok) { $problems += 'the browser check passed with a limit of 1 ms, so the limit was not applied' }
      elseif ($browser.detail -notmatch 'did not finish within 1 ms') { $problems += "the browser check failed for another reason than its limit: $($browser.detail)" }
    }
    foreach ($name in @('questions', 'sqlite')) {
      $check = @($report.checks) | Where-Object { $_.name -eq $name }
      if (-not $check -or -not $check.ok) { $problems += "the '$name' check did not pass in the timed-out run" }
    }
  }
  Add-Summary "### Self-check with the browser check timed out`n`nExit code $exitCode after $seconds s. Browser check: $($detail -replace '\|', '/')`n`nLeft running or left behind: $($problems.Count) problem(s)`n"
  return , $problems
}

function Invoke-SelfCheckStep {
  Write-Step 'Run the installed app with --self-check'
  $state = Read-State
  $installDir = Get-StateValue $state 'installDir' $null
  if (-not $installDir) { $installDir = Find-InstallDir }
  if (-not $installDir) { throw "$ProductName is not installed." }
  $exe = Join-Path $installDir $ExeName

  if (Test-Path -LiteralPath $ReportPath) { Remove-Item -LiteralPath $ReportPath -Force }
  $exitCode = Invoke-SelfCheckRun $exe $installDir '--self-check'
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

  $problems += Test-ReportedCleanup $report 'the self-check'
  $problems += Test-NothingLeftRunning $installDir 'the self-check'
  if (Test-Path -LiteralPath $ScratchProfileDir) { $problems += "the scratch browser profile was left behind at $ScratchProfileDir" }

  $problems += Invoke-TimedOutSelfCheck $exe $installDir

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
