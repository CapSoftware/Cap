param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Fixture,
  [Parameter(Mandatory = $true)][string]$Variant
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$results = Join-Path $Out "result.txt"
Set-Content -Path $results -Value "variant=$Variant"
function Result([string]$key, $value) {
  Add-Content -Path $results -Value "$key=$value"
  Write-Host "$key=$value"
}
function Shot([string]$name) {
  try {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
  } catch { Write-Host "screenshot $name failed: $_" }
}

$profileDir = Join-Path $Out "profile"
$recordings = Join-Path $profileDir "recordings"
New-Item -ItemType Directory -Force -Path $recordings, (Join-Path $profileDir "logs") | Out-Null
Set-Content -Path (Join-Path $profileDir "store") -Value '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}'

function New-Recording([string]$name) {
  $dir = Join-Path $recordings "$name.cap"
  $segment = Join-Path $dir "content\segments\segment-0"
  New-Item -ItemType Directory -Force -Path $segment | Out-Null
  Copy-Item $Fixture (Join-Path $segment "display.mp4")
  $meta = '{"pretty_name":"' + $name + '","segments":[{"display":{"path":"content/segments/segment-0/display.mp4","fps":30}}],"status":{"status":"Complete"}}'
  [System.IO.File]::WriteAllText((Join-Path $dir "recording-meta.json"), $meta)
  return $dir
}
$target = New-Recording "target"
$source = New-Recording "source"
$plain = Join-Path $recordings "Holiday photos"
New-Item -ItemType Directory -Force -Path $plain | Out-Null
Set-Content -Path (Join-Path $plain "note.txt") -Value "not a recording"

function Segments([string]$project) {
  $meta = Get-Content (Join-Path $project "recording-meta.json") -Raw | ConvertFrom-Json
  return @($meta.segments).Count
}

$env:CAP_GPUI_APP_DATA_DIR = $profileDir
$env:CAP_GPUI_RECORDINGS_DIR = $recordings
$env:CAP_GPUI_LOG_DIR = Join-Path $profileDir "logs"
$env:CAP_GPUI_AUTO_NO_MIC = "1"
$env:CAP_GPUI_AUTO_EDITOR = $target
$env:CAP_GPUI_AUTO_IMPORT_EXISTING = "1"
$env:RUST_LOG = "info"
$env:NO_COLOR = "1"

function Log-Text([string]$name) {
  $text = ""
  $files = @((Join-Path $Out "$name.out.log"), (Join-Path $Out "$name.err.log"))
  foreach ($file in $files) {
    if (Test-Path $file) {
      try {
        $stream = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object System.IO.StreamReader $stream
        $text += $reader.ReadToEnd()
        $reader.Dispose(); $stream.Dispose()
      } catch {}
    }
  }
  return ($text -replace "\x1b\[[0-9;]*m", "")
}
function Wait-Log([string]$name, [string]$pattern, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Log-Text $name) -match $pattern) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$true_condition = [System.Windows.Automation.Condition]::TrueCondition
function Dialogs([int]$processId) {
  $found = @()
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $true_condition)) {
    try {
      if ($window.Current.ProcessId -eq $processId -and $window.Current.ClassName -eq "#32770") { $found += $window }
      elseif ($window.Current.ProcessId -eq $processId) {
        foreach ($child in $window.FindAll([System.Windows.Automation.TreeScope]::Children, $true_condition)) {
          if ($child.Current.ClassName -eq "#32770") { $found += $child }
        }
      }
    } catch {}
  }
  return $found
}
function Wait-Dialog([int]$processId, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $dialogs = @(Dialogs $processId)
    if ($dialogs.Count -gt 0) { return $dialogs[0] }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Dump([System.Windows.Automation.AutomationElement]$element, [string]$file) {
  $lines = @()
  try {
    foreach ($node in $element.FindAll([System.Windows.Automation.TreeScope]::Subtree, $true_condition)) {
      try {
        $c = $node.Current
        $lines += ("{0} | id={1} | class={2} | name={3} | enabled={4}" -f $c.ControlType.ProgrammaticName, $c.AutomationId, $c.ClassName, $c.Name, $c.IsEnabled)
      } catch {}
    }
  } catch { $lines += "dump failed: $_" }
  Set-Content -Path (Join-Path $Out $file) -Value $lines
}
function Find-First([System.Windows.Automation.AutomationElement]$element, [scriptblock]$match) {
  foreach ($node in $element.FindAll([System.Windows.Automation.TreeScope]::Subtree, $true_condition)) {
    try { if (& $match $node.Current) { return $node } } catch {}
  }
  return $null
}
function Address([System.Windows.Automation.AutomationElement]$dialog) {
  $bar = Find-First $dialog { param($c) $c.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar -and $c.Name -like "Address:*" }
  if ($bar) { return ($bar.Current.Name -replace "^Address:\s*", "") }
  return ""
}
function Items([System.Windows.Automation.AutomationElement]$dialog) {
  $names = @()
  foreach ($node in $dialog.FindAll([System.Windows.Automation.TreeScope]::Subtree, $true_condition)) {
    try {
      if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and $node.Current.ClassName -eq "UIItem") { $names += $node.Current.Name }
    } catch {}
  }
  return $names
}
function Type-Path([System.Windows.Automation.AutomationElement]$dialog, [string]$path) {
  $edit = Find-First $dialog { param($c) $c.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and ($c.AutomationId -eq "1152" -or $c.AutomationId -eq "1148") }
  if (-not $edit) { return $false }
  $edit.SetFocus()
  $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $pattern.SetValue($path)
  return $true
}
function Press([System.Windows.Automation.AutomationElement]$dialog, [string]$id) {
  $button = Find-First $dialog { param($c) $c.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $c.AutomationId -eq $id }
  if (-not $button) { return "" }
  $name = $button.Current.Name
  try {
    $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
  } catch { Write-Host "press $id failed: $_" }
  return $name
}

function Launch([string]$name) {
  $process = Start-Process -FilePath $App -PassThru -RedirectStandardOutput (Join-Path $Out "$name.out.log") -RedirectStandardError (Join-Path $Out "$name.err.log")
  return $process
}
function Stop-App($process) {
  try { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } } catch {}
  Start-Sleep -Seconds 2
}

# Round 1: pick the recording folder.
$app1 = Launch "pick"
Result "editor_opened" (Wait-Log "pick" "editor project validated" 180)
Result "picker_requested" (Wait-Log "pick" "auto import existing: opening the picker" 180)
$dialog = Wait-Dialog $app1.Id 60
Result "dialog_opened" ($null -ne $dialog)
if ($dialog) {
  Start-Sleep -Seconds 2
  Shot "pick-1-opened"
  Dump $dialog "pick-dialog.txt"
  Result "dialog_title" $dialog.Current.Name
  $address = Address $dialog
  Result "dialog_address" $address
  Result "dialog_rooted_at_recordings" ($address.TrimEnd('\') -ieq $recordings.TrimEnd('\'))
  Result "dialog_items_at_root" ((Items $dialog) -join ";")
  $accept = Find-First $dialog { param($c) $c.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $c.AutomationId -eq "1" }
  Result "dialog_accept_button" $(if ($accept) { $accept.Current.Name } else { "" })
  Result "path_typed" (Type-Path $dialog $source)
  Start-Sleep -Seconds 1
  Shot "pick-2-typed"
  Result "accept_pressed" (Press $dialog "1")
  Start-Sleep -Seconds 3
  Shot "pick-3-accepted"
  $still = @(Dialogs $app1.Id)
  Result "dialog_still_open_after_accept" ($still.Count -gt 0)
  if ($still.Count -gt 0) {
    Dump $still[0] "pick-dialog-after-accept.txt"
    Result "dialog_title_after_accept" $still[0].Current.Name
    Result "dialog_address_after_accept" (Address $still[0])
    Result "dialog_items_after_accept" ((Items $still[0]) -join ";")
  }
}
Result "imported" (Wait-Log "pick" "clips imported" 60)
$log = Log-Text "pick"
Result "picked_path_logged" ([bool]($log -match "existing recording picked"))
Result "picked_line" (($log -split "`n" | Where-Object { $_ -match "existing recording picked|picker returned nothing|failed to import clip" } | Select-Object -First 1) -replace "\s+", " ")
Result "target_segments" (Segments $target)
$copied = @(Get-ChildItem -Path (Join-Path $target "content\segments") -Recurse -Filter "display.mp4")
Result "target_display_files" $copied.Count
Result "panics" (([regex]::Matches($log, "panicked at")).Count)
Result "app_alive_after_pick" (-not $app1.HasExited)
Start-Sleep -Seconds 3
Shot "pick-4-end"
foreach ($open in @(Dialogs $app1.Id)) { Press $open "2" | Out-Null }
Stop-App $app1

if ($Variant -eq "fix") {
  # Round 2: a folder that is not a recording gives the import error.
  $before = Get-FileHash (Join-Path $target "recording-meta.json")
  $app2 = Launch "reject"
  Wait-Log "reject" "auto import existing: opening the picker" 180 | Out-Null
  $dialog = Wait-Dialog $app2.Id 60
  Result "reject_dialog_opened" ($null -ne $dialog)
  if ($dialog) {
    Start-Sleep -Seconds 2
    Type-Path $dialog $plain | Out-Null
    Start-Sleep -Seconds 1
    Press $dialog "1" | Out-Null
  }
  Result "reject_logged" (Wait-Log "reject" "failed to import clip: Select a Cap project folder" 60)
  $error_dialog = $null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not $error_dialog) {
    foreach ($candidate in @(Dialogs $app2.Id)) {
      if (Find-First $candidate { param($c) $c.Name -like "*Select a Cap project folder*" }) { $error_dialog = $candidate }
    }
    Start-Sleep -Milliseconds 500
  }
  Result "reject_error_dialog_shown" ($null -ne $error_dialog)
  Shot "reject-1-error"
  if ($error_dialog) {
    Dump $error_dialog "reject-dialog.txt"
    Result "reject_error_title" $error_dialog.Current.Name
    $text = Find-First $error_dialog { param($c) $c.Name -like "*Select a Cap project folder*" }
    Result "reject_error_text" $text.Current.Name
    $ok = Find-First $error_dialog { param($c) $c.ControlType -eq [System.Windows.Automation.ControlType]::Button }
    if ($ok) { Press $error_dialog $ok.Current.AutomationId | Out-Null }
  }
  Start-Sleep -Seconds 2
  Result "reject_target_unchanged" ((Get-FileHash (Join-Path $target "recording-meta.json")).Hash -eq $before.Hash)
  Result "reject_app_alive" (-not $app2.HasExited)
  Result "reject_panics" (([regex]::Matches((Log-Text "reject"), "panicked at")).Count)
  Stop-App $app2

  # Round 3: cancelling the dialog imports nothing and shows no error.
  $app3 = Launch "cancel"
  Wait-Log "cancel" "auto import existing: opening the picker" 180 | Out-Null
  $dialog = Wait-Dialog $app3.Id 60
  Result "cancel_dialog_opened" ($null -ne $dialog)
  if ($dialog) { Start-Sleep -Seconds 2; Press $dialog "2" | Out-Null }
  Result "cancel_logged" (Wait-Log "cancel" "existing recording picker returned nothing" 30)
  Start-Sleep -Seconds 2
  Result "cancel_no_dialog_left" (@(Dialogs $app3.Id).Count -eq 0)
  Result "cancel_target_unchanged" ((Get-FileHash (Join-Path $target "recording-meta.json")).Hash -eq $before.Hash)
  Result "cancel_app_alive" (-not $app3.HasExited)
  Stop-App $app3
}
Get-Content $results
