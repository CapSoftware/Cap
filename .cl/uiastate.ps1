# uiastate.ps1 -TargetPid <pid> -Name <name> [-Prefix] [-Window <title>]: what Narrator reads about
# the first element of that process named <name> (or starting with it): type | name | selected |
# full description | patterns (Invoke, SelectionItem, ExpandCollapse).
param([int]$TargetPid, [string]$Name, [switch]$Prefix, [string]$Window = "")
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$P = [System.Windows.Automation.PropertyCondition]
$pidCond = New-Object $P($A::ProcessIdProperty, $TargetPid)
$scope = $A::RootElement
if ($Window -ne "") {
  $w = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.AndCondition($pidCond, (New-Object $P($A::NameProperty, $Window)))))
  if ($null -ne $w) { $scope = $w }
}
$el = $null
foreach ($e in $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $pidCond)) {
  $n = $e.Current.Name
  if (($Prefix -and $n.StartsWith($Name)) -or (-not $Prefix -and $n -eq $Name)) { $el = $e; break }
}
if ($null -eq $el) { "none | $Name | - | - | -"; exit 1 }
$t = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
$sel = "not-selectable"
$pattern = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
  $sel = if ($pattern.Current.IsSelected) { "selected" } else { "not-selected" }
}
# UIA_FullDescriptionPropertyId (30159) carries AccessKit's description (Narrator reads it after the
# name). The managed client predates it, so read it through UIAutomationCore's COM interface.
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICdCond {}
[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICdArr { int Length { get; } ICdEl GetElement(int i); }
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICdEl {
  void SetFocus(); void GetRuntimeId(); void FindFirst();
  ICdArr FindAll(int scope, ICdCond cond);
  void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int id);
}
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICdUia {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  ICdEl ElementFromHandle(IntPtr hwnd);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache(); void ElementFromHandleBuildCache();
  void ElementFromPointBuildCache(); void GetFocusedElementBuildCache(); void CreateTreeWalker();
  void ControlViewWalker(); void ContentViewWalker(); void RawViewWalker(); void RawViewCondition();
  void ControlViewCondition(); void ContentViewCondition(); void CreateCacheRequest();
  ICdCond CreateTrueCondition();
}
public static class CdFull {
  public static string Get(IntPtr hwnd, string name, bool prefix) {
    var uia = (ICdUia)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
    var all = uia.ElementFromHandle(hwnd).FindAll(4, uia.CreateTrueCondition());
    for (int i = 0; i < all.Length; i++) {
      var e = all.GetElement(i);
      var n = e.GetCurrentPropertyValue(30005) as string ?? "";
      if (prefix ? n.StartsWith(name) : n == name) return e.GetCurrentPropertyValue(30159) as string ?? "";
    }
    return "(not found by COM)";
  }
}
"@
$fd = ""
try {
  $top = $el; $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  while ($top.Current.NativeWindowHandle -eq 0) { $top = $walker.GetParent($top) }
  $fd = [CdFull]::Get([IntPtr]$top.Current.NativeWindowHandle, $Name, [bool]$Prefix)
} catch { $fd = "(error: $($_.Exception.Message))" }
$pats = @()
foreach ($p in $el.GetSupportedPatterns()) { $pats += ($p.ProgrammaticName -replace 'Identifiers\.Pattern', '') }
"$t | $($el.Current.Name) | $sel | $fd | $($pats -join ',')"
