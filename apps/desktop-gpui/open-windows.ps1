<#
.SYNOPSIS
Launches the debug build with every window open, without recording or taking a screenshot.

.EXAMPLE
./open-windows.ps1
./open-windows.ps1 -Windows editor,settings -Settings hotkeys
./open-windows.ps1 -Build -Windows all,camera
#>
[CmdletBinding()]
param(
	[ValidateSet("all", "main", "settings", "editor", "screenshot-editor", "mode-select", "teleprompter", "onboarding", "camera", "overlay")]
	[string[]]$Windows = @("all"),
	[string]$Settings = "general",
	[string]$Editor = "1",
	[string]$Screenshot = "1",
	[ValidateSet("display", "window", "area", "camera")]
	[string]$Overlay = "display",
	[string]$DataDir = "",
	[switch]$Build
)

$ErrorActionPreference = "Stop"
$appDir = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $appDir "../..")
$exe = Join-Path $appDir "target/debug/cap-gpui.exe"

if ($Build) {
	Push-Location $appDir
	try {
		cargo build --bin cap-gpui
		if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
	} finally {
		Pop-Location
	}
}
if (-not (Test-Path $exe)) { throw "No debug build at $exe. Run with -Build." }

$selected = [System.Collections.Generic.HashSet[string]]::new()
foreach ($name in $Windows) {
	if ($name -eq "all") {
		"main", "settings", "editor", "screenshot-editor", "mode-select", "teleprompter", "onboarding" |
			ForEach-Object { [void]$selected.Add($_) }
	} else {
		[void]$selected.Add($name)
	}
}

$hooks = [ordered]@{}
if ($selected.Contains("main")) { $hooks["CAP_GPUI_AUTO_SHOW_MAIN"] = "1" }
if ($selected.Contains("settings")) { $hooks["CAP_GPUI_AUTO_SETTINGS"] = $Settings }
if ($selected.Contains("editor")) { $hooks["CAP_GPUI_AUTO_EDITOR"] = $Editor }
if ($selected.Contains("screenshot-editor")) { $hooks["CAP_GPUI_AUTO_SCREENSHOT_EDITOR"] = $Screenshot }
if ($selected.Contains("mode-select")) { $hooks["CAP_GPUI_AUTO_MODE_SELECT"] = "1" }
if ($selected.Contains("teleprompter")) { $hooks["CAP_GPUI_AUTO_TELEPROMPTER"] = "1" }
if ($selected.Contains("onboarding")) { $hooks["CAP_GPUI_AUTO_PERMISSIONS"] = "1" }
if ($selected.Contains("camera")) { $hooks["CAP_GPUI_AUTO_CAMERA"] = "1" }
if ($selected.Contains("overlay")) { $hooks["CAP_GPUI_AUTO_OVERLAY"] = $Overlay }

$running = Get-Process cap-gpui -ErrorAction SilentlyContinue |
	Where-Object { $_.Path -and $_.Path.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase) }
foreach ($process in $running) {
	Write-Host "Stopping running debug build (PID $($process.Id)) so the new launch is not handed to it."
	Stop-Process -Id $process.Id
	$process.WaitForExit(5000) | Out-Null
}

$start = New-Object System.Diagnostics.ProcessStartInfo $exe
$start.UseShellExecute = $false
$start.WorkingDirectory = $appDir
$start.Environment["PATH"] = (Join-Path $repoRoot "target/debug") + ";" + $env:PATH
if ($DataDir) {
	$data = [IO.Path]::GetFullPath($DataDir)
	$start.Environment["CAP_GPUI_APP_DATA_DIR"] = $data
	$start.Environment["CAP_GPUI_RECORDINGS_DIR"] = Join-Path $data "recordings"
	$start.Environment["CAP_GPUI_LOG_DIR"] = Join-Path $data "logs"
}
foreach ($key in $hooks.Keys) { $start.Environment[$key] = $hooks[$key] }

$app = [System.Diagnostics.Process]::Start($start)
Write-Host "Launched Cap (PID $($app.Id)) opening: $(($selected | Sort-Object) -join ', ')"

Add-Type -Namespace CapDev -Name Windows -MemberDefinition @"
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
public static System.Collections.Generic.List<string> Titles(uint pid) {
	var titles = new System.Collections.Generic.List<string>();
	EnumWindows((h, l) => {
		uint owner; GetWindowThreadProcessId(h, out owner);
		if (owner != pid || !IsWindowVisible(h)) return true;
		var text = new System.Text.StringBuilder(128); GetWindowText(h, text, 128);
		if (text.Length > 0) titles.Add(text.ToString());
		return true;
	}, System.IntPtr.Zero);
	return titles;
}
"@

$expected = $selected.Count
$deadline = (Get-Date).AddSeconds(20)
$titles = @()
while ((Get-Date) -lt $deadline -and -not $app.HasExited) {
	Start-Sleep -Milliseconds 500
	$titles = @([CapDev.Windows]::Titles([uint32]$app.Id) | Sort-Object -Unique)
	if ($titles.Count -ge $expected) { break }
}
if ($app.HasExited) { throw "Cap exited during startup (exit code $($app.ExitCode))." }
Write-Host "Visible windows: $($titles -join ', ')"
