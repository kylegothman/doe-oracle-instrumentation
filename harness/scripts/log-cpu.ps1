<#
.SYNOPSIS
  Logs the CPU use of the harness, its subject browser, and Ollama once a
  second, for the CPU half of the timing-overhead check (TC-NFR2-02, story #47).

.DESCRIPTION
  Start it before the twelve Oracle trials of TC-NFR2-01 and stop it with
  Ctrl+C after the last one:

    powershell -ExecutionPolicy Bypass -File scripts\log-cpu.ps1

  Every second it writes one line to a CSV file: the time in UTC, then the
  CPU used in that second by three groups of processes, each as a share of
  the whole machine (100 means every core busy):

    harness  the harness's own processes: every process of the installed app,
             "DOE Oracle Test Harness.exe" (main, renderer, GPU, helpers);
    browser  the Chromium the harness drives, which shows the subject's page;
    ollama   Ollama and the model runners it starts.

  Only "harness" counts toward NFR-2. The other two are logged separately, as
  the Test Plan asks, so the report can show them without counting them.
  scripts/nfr2-report.mjs reads this file together with the session's export
  and averages each group over the trials only.

  This does what the Test Plan's Performance Monitor step does, from the same
  source: the processor time Windows keeps for each process, divided by the
  elapsed time and the number of logical processors.

  To log the harness run from source (npm run dev), pass its process name:

    powershell -ExecutionPolicy Bypass -File scripts\log-cpu.ps1 -HarnessProcessName electron

  It only reads. It changes nothing and makes no network call. Works in
  Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER OutFile
  Where to write the CSV. Default: cpu-log-<date>-<time>.csv in the current folder.

.PARAMETER IntervalSeconds
  Seconds between samples. Default: 1, as the Test Plan asks.

.PARAMETER HarnessProcessName
  The harness's process name, without .exe. Default: DOE Oracle Test Harness.

.PARAMETER Minutes
  Stop by itself after this many minutes. Default: 0, which runs until Ctrl+C.
#>
[CmdletBinding()]
param(
  [string]$OutFile = (Join-Path (Get-Location) ('cpu-log-{0}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [double]$IntervalSeconds = 1,
  [string]$HarnessProcessName = 'DOE Oracle Test Harness',
  [int]$Minutes = 0
)

$ErrorActionPreference = 'Stop'
$invariant = [Globalization.CultureInfo]::InvariantCulture
$cores = [Environment]::ProcessorCount
$groups = @('harness', 'browser', 'ollama')

# The harness's Chromium is the one it ships (resources\browser\chromium-<revision>),
# or Playwright's own when run from source. Any other Chrome or Edge is not counted.
$browserPathPattern = '\\browser\\chromium-|\\ms-playwright\\|\\\.browser-bundle\\'

function Get-ProcessGroup([System.Diagnostics.Process]$process) {
  if ($process.ProcessName -eq $HarnessProcessName) { return 'harness' }
  if ($process.ProcessName -like 'ollama*') { return 'ollama' }
  $path = $null
  try { $path = $process.Path } catch { $path = $null }
  if ($path -and $path -match $browserPathPattern) { return 'browser' }
  return $null
}

# Processor time used so far by every process in a group, by process ID, in milliseconds.
function Read-ProcessorTimes {
  $times = @{}
  foreach ($process in Get-Process) {
    $group = Get-ProcessGroup $process
    if (-not $group) { continue }
    $used = $null
    try { $used = $process.TotalProcessorTime } catch { $used = $null }
    if ($null -eq $used) { continue }
    $times[$process.Id] = @{ Group = $group; Ms = $used.TotalMilliseconds }
  }
  return $times
}

function Format-Number([double]$value) {
  return $value.ToString('0.00', $invariant)
}

$header = 'timestamp_utc,' + (($groups | ForEach-Object { "$($_)_pct" }) -join ',') + ',' + (($groups | ForEach-Object { "$($_)_processes" }) -join ',')
Set-Content -Path $OutFile -Value $header -Encoding ASCII

$clock = [Diagnostics.Stopwatch]::StartNew()
$previous = Read-ProcessorTimes
$previousAt = $clock.Elapsed.TotalMilliseconds
$stopAt = [double]::MaxValue
if ($Minutes -gt 0) { $stopAt = $Minutes * 60000.0 }

$harnessFound = @($previous.Values | Where-Object { $_.Group -eq 'harness' }).Count
if ($harnessFound -eq 0) {
  Write-Warning "No process named '$HarnessProcessName' is running. Start the harness first, or pass -HarnessProcessName."
}
Write-Host "Logging CPU use once every $IntervalSeconds s on $cores logical processors to $OutFile"
Write-Host 'Press Ctrl+C to stop.'

$intervalMs = $IntervalSeconds * 1000.0
$nextAt = $previousAt + $intervalMs
while ($clock.Elapsed.TotalMilliseconds -lt $stopAt) {
  # Sleep to the next whole interval, so reading the processes does not make the samples drift apart.
  $wait = $nextAt - $clock.Elapsed.TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
  $nextAt += $intervalMs
  $current = Read-ProcessorTimes
  $now = $clock.Elapsed.TotalMilliseconds
  $elapsed = $now - $previousAt

  $used = @{}
  $count = @{}
  foreach ($group in $groups) { $used[$group] = 0.0; $count[$group] = 0 }
  foreach ($id in $current.Keys) {
    $entry = $current[$id]
    $count[$entry.Group] += 1
    # A process seen for the first time is counted from the next sample on.
    if ($previous.ContainsKey($id) -and $previous[$id].Group -eq $entry.Group) {
      $delta = $entry.Ms - $previous[$id].Ms
      if ($delta -gt 0) { $used[$entry.Group] += $delta }
    }
  }

  $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
  $percents = $groups | ForEach-Object { Format-Number ($used[$_] / ($elapsed * $cores) * 100) }
  $counts = $groups | ForEach-Object { $count[$_] }
  Add-Content -Path $OutFile -Value ($stamp + ',' + ($percents -join ',') + ',' + ($counts -join ',')) -Encoding ASCII

  $previous = $current
  $previousAt = $now
}
