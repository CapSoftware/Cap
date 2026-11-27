param([string]$Mode, [int]$TargetPid, [string]$Out = "", [int]$Count = 14)
# uia.ps1 tree|tab|front <pid> [out] [count]: what Narrator can see of one process (UI Automation).
#   tree  every element under the process's top-level windows: depth type | name | focusable | focused
#   tab   brings the largest window to the front, presses Tab <count> times (SendKeys) and prints
#         the focused element after each
#   front brings the largest window to the front only
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CdWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }
"@
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $TargetPid)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$lines = New-Object System.Collections.Generic.List[string]
$stats = @{ nodes = 0; named = 0; focusable = 0 }

function Describe($e) {
  $c = $e.Current
  $t = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  $f = ""; if ($c.IsKeyboardFocusable) { $f += "F" }; if ($c.HasKeyboardFocus) { $f += "*" }; if (-not $c.IsEnabled) { $f += "D" }
  "$t | $($c.Name) | $($c.AutomationId) | $f"
}
function Walk($e, $depth) {
  if ($depth -gt 60) { return }
  try { $d = Describe $e } catch { $lines.Add(("  " * $depth) + "ERR"); return }
  $stats.nodes++
  if ($e.Current.Name) { $stats.named++ }
  if ($e.Current.IsKeyboardFocusable) { $stats.focusable++ }
  $lines.Add(("  " * $depth) + $d)
  $child = $walker.GetFirstChild($e)
  while ($child -ne $null) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
function Largest() {
  $best = $null; $area = 0
  foreach ($w in $wins) { $r = $w.Current.BoundingRectangle; if ($r.Width * $r.Height -gt $area) { $area = $r.Width * $r.Height; $best = $w } }
  $best
}

if ($Mode -eq "tree") {
  foreach ($w in $wins) { Walk $w 0 }
  $lines.Add("# windows=$($wins.Count) nodes=$($stats.nodes) named=$($stats.named) focusable=$($stats.focusable)")
  $lines | Out-File -Encoding utf8 $Out
} else {
  $w = Largest
  if ($w -ne $null) {
    [CdWin]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null
    try { $w.SetFocus() } catch {}
  }
  Start-Sleep -Milliseconds 600
  if ($Mode -eq "tab") {
    for ($k = 1; $k -le $Count; $k++) {
      [CdWin]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero); [CdWin]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 600
      $f = $A::FocusedElement
      $desc = if ($f -ne $null) { try { Describe $f } catch { "ERR" } } else { "(none)" }
      $pidf = if ($f -ne $null) { try { $f.Current.ProcessId } catch { 0 } } else { 0 }
      $lines.Add(("tab {0:D2}: pid={1} {2}" -f $k, $pidf, $desc))
    }
    $lines | Out-File -Encoding utf8 $Out
  }
}
