# clinvoke.ps1 -AppPid <pid> -Name <name>: presses (UI Automation Invoke, what Narrator does on
# Enter / Space) the first element of that process whose name is exactly <name> (inside the element
# named <within>, if given). Prints what it
# found and the result. Exit 0 pressed, 1 not found, 2 no Invoke pattern.
param([int]$AppPid, [string]$Name, [string]$Within = "")
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$PC = [System.Windows.Automation.PropertyCondition]
$cond = New-Object System.Windows.Automation.AndCondition(
  (New-Object $PC($AE::ProcessIdProperty, $AppPid)),
  (New-Object $PC($AE::NameProperty, $Name)))
# Only the app's own top-level windows are searched, never the whole desktop.
$wins = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
  (New-Object $PC($AE::ProcessIdProperty, $AppPid)))
$el = $null
foreach ($w in $wins) {
  $scope = $w
  if ($Within -ne "") {
    $scope = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object $PC($AE::NameProperty, $Within)))
    if ($null -eq $scope) { continue }
  }
  $el = $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($null -ne $el) { break }
}
if ($null -eq $el -and $Within -ne "") { "no element named '$Name' inside '$Within'"; exit 1 }
if ($null -eq $el) { "no element named '$Name'"; exit 1 }
$ct = $el.Current.ControlType.ProgrammaticName
$pat = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
  $pat.Invoke()
  "pressed $ct '$Name' (Invoke)"
  exit 0
}
if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
  $before = $pat.Current.ToggleState
  $pat.Toggle()
  Start-Sleep -Milliseconds 800
  "pressed $ct '$Name' (Toggle) state $before -> $($pat.Current.ToggleState)"
  exit 0
}
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
  $before = $pat.Current.IsSelected
  $pat.Select()
  Start-Sleep -Milliseconds 800
  "pressed $ct '$Name' (SelectionItem.Select) selected $before -> $($pat.Current.IsSelected)"
  exit 0
}
"found $ct '$Name' but it has no Invoke, Toggle or SelectionItem pattern"
exit 2
