param(
	[string]$Exe,
	[string]$Dir,
	[string]$Dll,
	[string]$Build,
	[string]$Kind,
	[int]$Threads,
	[string]$Exit,
	[int]$N,
	[string]$Wer = "nower"
)
$codes = @{}
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt $N; $i++) {
	$psi = New-Object Diagnostics.ProcessStartInfo
	$psi.FileName = $Exe
	$psi.Arguments = "`"$Dir`" $Dll $Kind $Threads $Exit $Wer"
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$p = [Diagnostics.Process]::Start($psi)
	$null = $p.StandardOutput.ReadToEnd()
	if ($p.WaitForExit(15000)) {
		$c = "0x{0:x8}" -f $p.ExitCode
	} else {
		$p.Kill()
		$c = "hang"
	}
	if ($codes.ContainsKey($c)) { $codes[$c]++ } else { $codes[$c] = 1 }
}
$ok = if ($codes.ContainsKey("0x00000000")) { $codes["0x00000000"] } else { 0 }
$bad = $N - $ok
$summary = ($codes.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join " "
$line = "| $env:RUNNER_LABEL | $Build | $Dll | $Kind x$Threads | $Exit | $N | $bad | {0:N2}% | $summary | {1:N0} s |" -f (100.0 * $bad / $N), $sw.Elapsed.TotalSeconds
Write-Host $line
Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $line
Add-Content -Path "$env:RUNNER_TEMP\results.md" -Value $line
