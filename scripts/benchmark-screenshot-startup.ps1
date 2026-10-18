param(
	[Parameter(Mandatory)][string]$Executable,
	[Parameter(Mandatory)][string]$OutputDirectory,
	[ValidateRange(1, 20)][int]$Samples = 5,
	[ValidateRange(10, 120)][int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$environmentNames = @(
	"CAP_GPUI_APP_DATA_DIR", "CAP_GPUI_TAURI_STORE", "CAP_GPUI_AUTO_HOTKEY",
	"CAP_GPUI_SCREENSHOT_PREPARE_WINDOW", "CAP_GPUI_SCREENSHOT_WARM_LAYERS", "RUST_LOG"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
	$originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$results = @()
Write-Host "Measures capture request to window opened using existing logs; does not measure rendered content."
try {
	for ($sample = 1; $sample -le $Samples; $sample++) {
		$runPath = Join-Path $outputPath ("run-{0}-{1}" -f $sample, [guid]::NewGuid().ToString("N"))
		New-Item -ItemType Directory -Path $runPath | Out-Null
		$env:CAP_GPUI_APP_DATA_DIR = Join-Path $runPath "profile"
		$env:CAP_GPUI_TAURI_STORE = Join-Path $runPath "store.json"
		$env:CAP_GPUI_AUTO_HOTKEY = "screenshotDisplay"
		$env:CAP_GPUI_SCREENSHOT_PREPARE_WINDOW = "0"
		$env:CAP_GPUI_SCREENSHOT_WARM_LAYERS = "0"
		$env:RUST_LOG = "warn,cap_gpui=info"
		$stdout = Join-Path $runPath "stdout.log"
		$stderr = Join-Path $runPath "stderr.log"
		$child = $null
		try {
			$child = Start-Process -FilePath $executablePath -WorkingDirectory (Split-Path $executablePath) -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
			$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
			$opened = $null
			while ([DateTime]::UtcNow -lt $deadline) {
				$lines = @(Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | ForEach-Object {
					$_ -replace '\x1B\[[0-?]*[ -/]*[@-~]', ""
				})
				$capture = $lines | Where-Object { $_ -match "taking a screenshot" } | Select-Object -First 1
				$opened = $lines | Where-Object { $_ -match "screenshot editor window opened" } | Select-Object -First 1
				if ($capture -and $opened) { break }
				if ($child.HasExited) { throw "Benchmark process exited; inspect $stderr" }
				Start-Sleep -Milliseconds 100
			}
			if (-not $capture -or -not $opened) { throw "Timed out; inspect $runPath" }
			$captureTime = [DateTimeOffset]::Parse(($capture -split "\s+")[0], [Globalization.CultureInfo]::InvariantCulture)
			$openedTime = [DateTimeOffset]::Parse(($opened -split "\s+")[0], [Globalization.CultureInfo]::InvariantCulture)
			$results += [pscustomobject]@{
				Sample = $sample
				CaptureRequestToWindowOpenedMs = ($openedTime - $captureTime).TotalMilliseconds
				LogDirectory = $runPath
			}
			$results | Export-Csv -LiteralPath (Join-Path $outputPath "results.csv") -NoTypeInformation
		} finally {
			if ($child) {
				if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force }
				$child.WaitForExit()
				$child.Dispose()
			}
		}
	}
} finally {
	foreach ($name in $environmentNames) {
		[Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
	}
}
$results
