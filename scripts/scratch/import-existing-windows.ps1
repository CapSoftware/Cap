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
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  public static string Title(IntPtr hwnd) { var text = new StringBuilder(1024); GetWindowText(hwnd, text, 1024); return text.ToString(); }
  public static string Class(IntPtr hwnd) { var text = new StringBuilder(256); GetClassName(hwnd, text, 256); return text.ToString(); }
  public static List<IntPtr> Windows(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, lparam) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid && IsWindowVisible(hwnd)) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<string> ChildTexts(IntPtr hwnd) {
    var found = new List<string>();
    EnumChildWindows(hwnd, (child, lparam) => { found.Add(Class(child) + " #" + GetDlgCtrlID(child) + ": " + Title(child)); return true; }, IntPtr.Zero);
    return found;
  }
  public static void Raise(IntPtr hwnd) { SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0043); }
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, string lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeout")] static extern IntPtr SendMessageTimeoutText(IntPtr hwnd, uint message, IntPtr wparam, StringBuilder lparam, uint flags, uint timeout, out IntPtr result);
  public static bool SetText(IntPtr hwnd, string text) { IntPtr result; return SendMessageTimeout(hwnd, 0x000C, IntPtr.Zero, text, 0x0002, 10000, out result) != IntPtr.Zero; }
  public static string GetText(IntPtr hwnd) { var text = new StringBuilder(2048); IntPtr result; SendMessageTimeoutText(hwnd, 0x000D, new IntPtr(2048), text, 0x0002, 10000, out result); return text.ToString(); }
  public static List<IntPtr> Children(IntPtr hwnd) {
    var found = new List<IntPtr>();
    EnumChildWindows(hwnd, (child, lparam) => { found.Add(child); return true; }, IntPtr.Zero);
    return found;
  }
}
"@

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

function Log-Text([string]$name) {
  $text = ""
  $file = Join-Path $Out "$name.out.log"
  if (Test-Path $file) {
    try {
      $stream = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
      $reader = New-Object System.IO.StreamReader $stream
      $text = $reader.ReadToEnd()
      $reader.Dispose(); $stream.Dispose()
    } catch {}
  }
  return ($text -replace "\x1b\[[0-9;]*m", "")
}
function Wait-Log($process, [string]$name, [string]$pattern, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Log-Text $name) -match $pattern) { return $true }
    if ($process -and $process.HasExited) { return ((Log-Text $name) -match $pattern) }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Lines([string]$name, [string]$pattern) {
  return @((Log-Text $name) -split "`n" | Where-Object { $_ -match $pattern })
}

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
function Cond([string]$property, $value) {
  $p = switch ($property) {
    "type" { $UIA::ControlTypeProperty }
    "id" { $UIA::AutomationIdProperty }
    "class" { $UIA::ClassNameProperty }
  }
  return New-Object System.Windows.Automation.PropertyCondition($p, $value)
}
function Both($a, $b) { return New-Object System.Windows.Automation.AndCondition($a, $b) }

# A dialog of the app: a visible top-level window of its process with the dialog class.
function Dialog-Handles([int]$processId, [string]$title) {
  return @([Win]::Windows([uint32]$processId) | Where-Object {
      [Win]::Class($_) -eq "#32770" -and (-not $title -or [Win]::Title($_) -eq $title)
    })
}
function Wait-Dialog($process, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { return $null }
    $handles = @(Dialog-Handles $process.Id "")
    if ($handles.Count -gt 0) { return $handles[0] }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Element([IntPtr]$handle) { return $UIA::FromHandle($handle) }
function Dump([IntPtr]$handle, [string]$file) {
  $lines = @("window: " + [Win]::Title($handle) + " [" + [Win]::Class($handle) + "]")
  $lines += [Win]::ChildTexts($handle)
  Set-Content -Path (Join-Path $Out $file) -Value $lines
}
function Address([IntPtr]$handle) {
  foreach ($child in [Win]::Children($handle)) {
    $text = [Win]::Title($child)
    if ([Win]::Class($child) -eq "ToolbarWindow32" -and $text -like "Address: *") { return ($text -replace "^Address:\s*", "") }
  }
  return ""
}
function Items([IntPtr]$handle) {
  $names = @()
  try {
    $condition = Both (Cond "type" ([System.Windows.Automation.ControlType]::ListItem)) (Cond "class" "UIItem")
    foreach ($item in (Element $handle).FindAll($Scope::Descendants, $condition)) { $names += $item.Current.Name }
  } catch { Write-Host "items failed: $_" }
  return $names
}
function Child([IntPtr]$handle, [string]$class, [int]$id) {
  foreach ($child in [Win]::Children($handle)) {
    if ([Win]::Class($child) -eq $class -and [Win]::GetDlgCtrlID($child) -eq $id) { return $child }
  }
  return [IntPtr]::Zero
}
# The folder dialog's "Folder:" field is edit 1152; the file dialog's "File name:"
# field is the edit inside combo box 1148.
function Path-Field([IntPtr]$handle) {
  $edit = Child $handle "Edit" 1152
  if ($edit -ne [IntPtr]::Zero) { return $edit }
  $combo = Child $handle "ComboBoxEx32" 1148
  if ($combo -ne [IntPtr]::Zero) {
    foreach ($child in [Win]::Children($combo)) { if ([Win]::Class($child) -eq "Edit") { return $child } }
  }
  return [IntPtr]::Zero
}
function Type-Path([IntPtr]$handle, [string]$path) {
  $edit = Path-Field $handle
  if ($edit -eq [IntPtr]::Zero) { return $false }
  [Win]::SetText($edit, $path) | Out-Null
  return ([Win]::GetText($edit) -eq $path)
}
function Button-Name([IntPtr]$handle, [int]$id) {
  $button = Child $handle "Button" $id
  if ($button -eq [IntPtr]::Zero) { return "" }
  return ([Win]::Title($button) -replace "&", "")
}
function Press([IntPtr]$handle, [int]$id) {
  $button = Child $handle "Button" $id
  [Win]::PostMessage($handle, 0x0111, [IntPtr]$id, $button) | Out-Null
  return (Button-Name $handle $id)
}

function Stop-App($process) {
  try { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } } catch {}
  Start-Sleep -Seconds 2
}
# The runner renders on Microsoft's software adapter, which can lose its device or
# crash inside d3d10warp.dll while the editor draws its first preview frame, before
# the picker is asked for. Launch again when that happens and count it.
$script:launches = 0
$script:crashes = 0
function Open-Picker([string]$round) {
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $name = "$round-$attempt"
    $script:launches++
    $process = Start-Process -FilePath $App -PassThru -RedirectStandardOutput (Join-Path $Out "$name.out.log") -RedirectStandardError (Join-Path $Out "$name.err.log")
    Wait-Log $process $name "auto import existing: opening the picker" 240 | Out-Null
    $handle = Wait-Dialog $process 60
    if ($handle) { return @{ Process = $process; Name = $name; Dialog = $handle } }
    $script:crashes++
    Write-Host "$name did not reach the picker (exited=$($process.HasExited))"
    Stop-App $process
  }
  return $null
}

# Round 1: pick the recording folder.
$round = Open-Picker "pick"
Result "dialog_opened" ($null -ne $round)
if ($round) {
  $dialog = $round.Dialog; $process = $round.Process; $name = $round.Name
  Result "editor_opened" ([bool]((Log-Text $name) -match "editor project validated"))
  Start-Sleep -Seconds 2
  [Win]::Raise($dialog)
  Shot "pick-1-opened"
  Dump $dialog "pick-dialog.txt"
  Result "dialog_title" ([Win]::Title($dialog))
  $address = Address $dialog
  Result "dialog_address" $address
  Result "dialog_rooted_at_recordings" ($address.TrimEnd('\') -ieq $recordings.TrimEnd('\'))
  Result "dialog_items_at_root" ((Items $dialog) -join ";")
  Result "dialog_accept_button" (Button-Name $dialog 1)
  Result "dialog_has_folder_field" ((Child $dialog "Edit" 1152) -ne [IntPtr]::Zero)
  Result "path_typed" (Type-Path $dialog $source)
  Start-Sleep -Seconds 1
  Shot "pick-2-typed"
  Result "accept_pressed" (Press $dialog 1)
  Start-Sleep -Seconds 3
  $still = @(Dialog-Handles $process.Id ([Win]::Title($dialog)))
  Result "dialog_still_open_after_accept" ($still.Count -gt 0)
  if ($still.Count -gt 0) {
    [Win]::Raise($still[0])
    Shot "pick-3-still-open"
    Result "dialog_address_after_accept" (Address $still[0])
    Result "dialog_items_after_accept" ((Items $still[0]) -join ";")
  }
  Result "imported" (Wait-Log $process $name "clips imported" 60)
  Result "picked_line" ((Lines $name "existing recording picked|picker returned nothing" | Select-Object -First 1) -replace "^\S+\s+", "" -replace "\s+", " ")
  Result "imported_line" ((Lines $name "clips imported|failed to import clip" | Select-Object -First 1) -replace "^\S+\s+", "" -replace "\s+", " ")
  Start-Sleep -Seconds 5
  Shot "pick-4-end"
  Result "app_alive_after_pick" (-not $process.HasExited)
  foreach ($open in @(Dialog-Handles $process.Id "")) { Press $open 2 | Out-Null }
  Stop-App $process
}
Result "target_segments" (Segments $target)
Result "target_display_files" (@(Get-ChildItem -Path (Join-Path $target "content\segments") -Recurse -Filter "display.mp4").Count)

if ($Variant -eq "fix") {
  # Round 2: a folder that is not a recording gives the import error.
  $before = (Get-FileHash (Join-Path $target "recording-meta.json")).Hash
  $round = Open-Picker "reject"
  Result "reject_dialog_opened" ($null -ne $round)
  if ($round) {
    $dialog = $round.Dialog; $process = $round.Process; $name = $round.Name
    Start-Sleep -Seconds 2
    Result "reject_path_typed" (Type-Path $dialog $plain)
    Start-Sleep -Seconds 1
    Press $dialog 1 | Out-Null
    Result "reject_logged" (Wait-Log $process $name "failed to import clip: Select a Cap project folder" 60)
    $error_dialog = $null
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not $error_dialog) {
      $handles = @(Dialog-Handles $process.Id "Import Error")
      if ($handles.Count -gt 0) { $error_dialog = $handles[0] } else { Start-Sleep -Milliseconds 500 }
    }
    $listing = @([Win]::Windows([uint32]$process.Id) | ForEach-Object { [Win]::Title($_) + " [" + [Win]::Class($_) + "]" })
    Set-Content -Path (Join-Path $Out "reject-windows.txt") -Value $listing
    Result "reject_error_dialog_shown" ($null -ne $error_dialog)
    if ($error_dialog) {
      [Win]::Raise($error_dialog)
      Start-Sleep -Seconds 1
      Shot "reject-1-error"
      Dump $error_dialog "reject-dialog.txt"
      Result "reject_error_title" ([Win]::Title($error_dialog))
      Result "reject_error_text" (([Win]::ChildTexts($error_dialog) | Where-Object { $_ -like "Static: *" -and $_.Length -gt 8 } | Select-Object -First 1) -replace "^Static: ", "")
      [Win]::PostMessage($error_dialog, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
      Start-Sleep -Seconds 2
      Result "reject_error_dialog_dismissed" (-not [Win]::IsWindow($error_dialog))
    } else {
      Shot "reject-1-no-error"
    }
    Result "reject_target_unchanged" ((Get-FileHash (Join-Path $target "recording-meta.json")).Hash -eq $before)
    Result "reject_app_alive" (-not $process.HasExited)
    Stop-App $process
  }

  # Round 3: cancelling the dialog imports nothing and shows no error.
  $round = Open-Picker "cancel"
  Result "cancel_dialog_opened" ($null -ne $round)
  if ($round) {
    $dialog = $round.Dialog; $process = $round.Process; $name = $round.Name
    Start-Sleep -Seconds 2
    Press $dialog 2 | Out-Null
    Result "cancel_logged" (Wait-Log $process $name "existing recording picker returned nothing" 30)
    Start-Sleep -Seconds 2
    Result "cancel_no_dialog_left" (@(Dialog-Handles $process.Id "").Count -eq 0)
    Result "cancel_target_unchanged" ((Get-FileHash (Join-Path $target "recording-meta.json")).Hash -eq $before)
    Result "cancel_app_alive" (-not $process.HasExited)
    Stop-App $process
  }
}
Result "launches" $script:launches
Result "launches_lost_before_the_picker" $script:crashes
Get-Content $results
