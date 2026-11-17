param(
	[string]$Exe,
	[string]$Video,
	[int]$Threads,
	[string]$Exit,
	[int]$Delay,
	[int]$N,
	[string]$Label
)
$dumps = "$env:RUNNER_TEMP\loopdumps"
New-Item -ItemType Directory -Force $dumps | Out-Null
Get-ChildItem $dumps -Filter *.dmp | Remove-Item -Force
$codes = @{}
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt $N; $i++) {
	$psi = New-Object Diagnostics.ProcessStartInfo
	$psi.FileName = $Exe
	$psi.Arguments = "`"$Video`" $Threads $Exit $Delay"
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$p = [Diagnostics.Process]::Start($psi)
	$errTask = $p.StandardError.ReadToEndAsync()
	$null = $p.StandardOutput.ReadToEnd()
	if ($p.WaitForExit(30000)) { $c = "0x{0:x8}" -f $p.ExitCode } else { $p.Kill(); $c = "hang" }
	if ($codes.ContainsKey($c)) { $codes[$c]++ } else { $codes[$c] = 1 }
}
Start-Sleep 2
New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\keep" | Out-Null
Get-ChildItem $dumps -Filter *.dmp | Select-Object -First 2 | Copy-Item -Destination "$env:RUNNER_TEMP\keep"
$dumpCount = @(Get-ChildItem $dumps -Filter *.dmp).Count
$ok = if ($codes.ContainsKey("0x00000000")) { $codes["0x00000000"] } else { 0 }
$bad = [Math]::Max($N - $ok, $dumpCount)
$summary = ($codes.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join " "
$line = "| $env:RUNNER_LABEL | $Label | $Threads | $Exit | $N | $bad | {0:N2}% | $summary WER dumps=$dumpCount | {1:N0} s |" -f (100.0 * $bad / $N), $sw.Elapsed.TotalSeconds
Write-Host $line
Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $line
Add-Content -Path "$env:RUNNER_TEMP\results.md" -Value $line
