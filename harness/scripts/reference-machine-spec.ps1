<#
.SYNOPSIS
  Prints this machine's specification as a Markdown table, for
  harness/docs/reference-machine.md (story #45).

.DESCRIPTION
  Run it on the reference machine and paste the output into the table in
  docs/reference-machine.md:

    powershell -ExecutionPolicy Bypass -File scripts\reference-machine-spec.ps1

  or, to put it straight on the clipboard:

    powershell -ExecutionPolicy Bypass -File scripts\reference-machine-spec.ps1 | Set-Clipboard

  It only reads: nothing on the machine is changed, and it contacts no
  outside site. The one network call is to Ollama on this machine
  (127.0.0.1:11434), to list its models. A value it cannot read is printed as
  "not found", never guessed. Internet speed is not measured: fill that row
  in by hand.

  With -MemorySnapshot it prints how much memory is in use right now and by
  which of the Oracle's and the harness's processes, instead of the
  specification. Run that while the Oracle, the harness, and its browser are
  all open, for the 16 GB question in docs/reference-machine.md:

    powershell -ExecutionPolicy Bypass -File scripts\reference-machine-spec.ps1 -MemorySnapshot

  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding()]
param(
  # Where Ollama listens on this machine.
  [string]$OllamaUrl = 'http://127.0.0.1:11434',
  # The Oracle's repository folder, to read its Python environment. Defaults to the folder two levels above this script.
  [string]$RepoDir = '',
  # Print current memory use instead of the specification.
  [switch]$MemorySnapshot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NotFound = 'not found'
$ProductName = 'DOE Oracle Test Harness'
if (-not $RepoDir) {
  $RepoDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

# Runs a block and returns its text, or "not found" when it fails or gives nothing.
function Get-Value([scriptblock]$Block) {
  try {
    $value = & $Block
    if ($null -eq $value) { return $NotFound }
    $text = (@($value) | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join '; '
    if ($text) { return $text }
    return $NotFound
  }
  catch {
    return $NotFound
  }
}

# The first line a command prints, or "not found" when the command is missing or fails.
function Get-CommandOutput([string]$Command, [string[]]$Arguments) {
  return Get-Value {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return $null }
    $output = & $Command @Arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -and ($_ -notmatch '^Warning') }
    @($output)[0]
  }
}

function Format-Bytes([double]$Bytes) {
  return ('{0:N1} GB' -f ($Bytes / 1GB))
}

$rows = New-Object System.Collections.Generic.List[object]
function Add-Row([string]$Item, [string]$Value) {
  # A pipe would break the Markdown table.
  $rows.Add([pscustomobject]@{ Item = $Item; Value = ($Value -replace '\|', '/') })
}

# --- Memory snapshot (-MemorySnapshot) --------------------------------------

if ($MemorySnapshot) {
  $os = Get-CimInstance Win32_OperatingSystem
  $totalBytes = [double]$os.TotalVisibleMemorySize * 1KB
  $freeBytes = [double]$os.FreePhysicalMemory * 1KB
  Add-Row 'RAM usable' (Format-Bytes $totalBytes)
  Add-Row 'RAM in use' ("$(Format-Bytes ($totalBytes - $freeBytes)) ($([math]::Round(($totalBytes - $freeBytes) / $totalBytes * 100)) %)")
  Add-Row 'RAM available' (Format-Bytes $freeBytes)
  # Working set per program: the Oracle (Ollama, Python, Node), the harness, and its Chromium.
  $groups = [ordered]@{
    'Ollama'                         = 'ollama*'
    'Python (Oracle backend)'        = 'python*'
    'Node (Oracle frontend)'         = 'node*'
    'Harness'                        = 'DOE Oracle Test Harness*'
    'Chromium (harness browser)'     = 'chrome*'
  }
  foreach ($label in $groups.Keys) {
    $processes = @(Get-Process -Name $groups[$label] -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
      Add-Row $label 'not running'
    }
    else {
      $bytes = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum
      Add-Row $label "$(Format-Bytes $bytes) in $($processes.Count) process(es)"
    }
  }
  Write-Output "Memory snapshot taken $(Get-Date -Format 'yyyy-MM-dd HH:mm') local time with reference-machine-spec.ps1 -MemorySnapshot."
  Write-Output ''
  Write-Output '| Item | Value |'
  Write-Output '| --- | --- |'
  foreach ($row in $rows) {
    Write-Output "| $($row.Item) | $($row.Value) |"
  }
  exit 0
}

# --- Hardware ---------------------------------------------------------------

Add-Row 'Model' (Get-Value {
    $system = Get-CimInstance Win32_ComputerSystem
    "$($system.Manufacturer) $($system.Model)"
  })
Add-Row 'CPU' (Get-Value {
    Get-CimInstance Win32_Processor | ForEach-Object {
      "$($_.Name.Trim()), $($_.NumberOfCores) cores, $($_.NumberOfLogicalProcessors) logical processors"
    }
  })
Add-Row 'RAM' (Get-Value {
    $installed = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum
    $usable = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    "$(Format-Bytes $installed) installed, $(Format-Bytes $usable) usable"
  })
Add-Row 'GPU' (Get-Value {
    Get-CimInstance Win32_VideoController | ForEach-Object {
      # AdapterRAM is a 32-bit field and under-reports cards with more than 4 GB, so it is not printed.
      "$($_.Name), driver $($_.DriverVersion)"
    }
  })
Add-Row 'Storage' (Get-Value {
    Get-PhysicalDisk | ForEach-Object {
      "$($_.FriendlyName), $($_.MediaType), $($_.BusType), $(Format-Bytes $_.Size)"
    }
  })
Add-Row 'Free space on the system drive' (Get-Value {
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    "$(Format-Bytes $drive.FreeSpace) free of $(Format-Bytes $drive.Size) on $($env:SystemDrive)"
  })
Add-Row 'Display' (Get-Value {
    Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | ForEach-Object {
      "$($_.CurrentHorizontalResolution) x $($_.CurrentVerticalResolution) at $($_.CurrentRefreshRate) Hz"
    }
  })
Add-Row 'Display scale' (Get-Value {
    $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI).AppliedDPI
    "$([math]::Round($dpi / 96 * 100)) % ($dpi DPI, as of the last sign-in)"
  })

# --- Windows ----------------------------------------------------------------

Add-Row 'Windows edition' (Get-Value { (Get-CimInstance Win32_OperatingSystem).Caption })
Add-Row 'Windows version and build' (Get-Value {
    $current = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    "$($current.DisplayVersion), OS build $($current.CurrentBuild).$($current.UBR)"
  })
Add-Row 'Power source' (Get-Value {
    $battery = @(Get-CimInstance Win32_Battery)
    if ($battery.Count -eq 0) { return 'No battery (desktop, always on mains power)' }
    # BatteryStatus 2 means the battery is not discharging: the machine is on mains power.
    if ($battery[0].BatteryStatus -eq 2) { return "Plugged in, battery at $($battery[0].EstimatedChargeRemaining) %" }
    "On battery, at $($battery[0].EstimatedChargeRemaining) %"
  })
Add-Row 'Power plan' (Get-Value {
    $line = & powercfg.exe /getactivescheme
    if ("$line" -match '\((.+)\)\s*$') { return $Matches[1] }
    "$line"
  })

# --- Network ----------------------------------------------------------------

Add-Row 'Network type and link speed' (Get-Value {
    Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
      "$($_.Name): $($_.MediaType), $($_.InterfaceDescription), link speed $($_.LinkSpeed)"
    }
  })
Add-Row 'Internet speed (download / upload, Mbps)' 'fill in by hand; this script does not measure it'

# --- Software ---------------------------------------------------------------

Add-Row 'Ollama version' (Get-Value { (Invoke-RestMethod -Uri "$OllamaUrl/api/version" -TimeoutSec 5).version })
Add-Row 'Ollama model tags' (Get-Value {
    (Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -TimeoutSec 5).models | Sort-Object name | ForEach-Object {
      $digest = "$($_.digest)"
      if ($digest.Length -gt 12) { $digest = $digest.Substring(0, 12) }
      "$($_.name) ($($_.details.parameter_size), $($_.details.quantization_level), id $digest)"
    }
  })
Add-Row 'Ollama models loaded now (and on CPU or GPU)' (Get-Value {
    $loaded = @((Invoke-RestMethod -Uri "$OllamaUrl/api/ps" -TimeoutSec 5).models)
    if ($loaded.Count -eq 0) { return 'none loaded' }
    $loaded | ForEach-Object {
      $where = 'CPU'
      if ($_.size_vram -gt 0 -and $_.size_vram -ge $_.size) { $where = 'GPU' }
      elseif ($_.size_vram -gt 0) { $where = 'CPU and GPU' }
      "$($_.name) on $where"
    }
  })
Add-Row 'Python (on PATH)' (Get-CommandOutput 'python' @('--version'))
Add-Row "Python (the Oracle's venv)" (Get-Value {
    $venvPython = Join-Path (Join-Path (Join-Path $RepoDir 'venv') 'Scripts') 'python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) { return $null }
    & $venvPython --version 2>&1 | ForEach-Object { "$_" }
  })
Add-Row 'Node' (Get-CommandOutput 'node' @('--version'))
Add-Row 'ffmpeg' (Get-CommandOutput 'ffmpeg' @('-version'))
Add-Row 'Git commit of the Oracle checkout' (Get-Value {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
    & git -C $RepoDir rev-parse --short HEAD 2>$null
  })
Add-Row 'Harness version' (Get-Value {
    $roots = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $roots) {
      foreach ($item in @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)) {
        $name = $item.PSObject.Properties['DisplayName']
        if ($null -ne $name -and $name.Value -eq $ProductName) { return $item.DisplayVersion }
      }
    }
    $null
  })
Add-Row 'Harness browser' (Get-Value {
    $manifestPath = Join-Path $env:LOCALAPPDATA "Programs\$ProductName\resources\browser\browser.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    "Chrome for Testing $($manifest.browserVersion) (Playwright $($manifest.playwrightVersion), revision $($manifest.revision))"
  })

# --- Output -----------------------------------------------------------------

Write-Output "Recorded $(Get-Date -Format 'yyyy-MM-dd HH:mm') local time with reference-machine-spec.ps1."
Write-Output ''
Write-Output '| Item | Value |'
Write-Output '| --- | --- |'
foreach ($row in $rows) {
  Write-Output "| $($row.Item) | $($row.Value) |"
}
