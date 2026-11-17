param(
	[string]$Exe,
	[string]$Arguments,
	[int]$N,
	[string]$Label,
	[string]$Request = ""
)
$dumps = "$env:RUNNER_TEMP\loopdumps"
New-Item -ItemType Directory -Force $dumps | Out-Null
Get-ChildItem $dumps -Filter *.dmp | Remove-Item -Force
$codes = @{}
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt $N; $i++) {
	$psi = New-Object Diagnostics.ProcessStartInfo
	$psi.FileName = $Exe
	$psi.Arguments = $Arguments
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.RedirectStandardInput = $true
	if ($Request) { $psi.EnvironmentVariables["CAP_H264_SELF_TEST_REQUEST"] = $Request }
	$p = [Diagnostics.Process]::Start($psi)
	$p.StandardInput.Close()
	$errTask = $p.StandardError.ReadToEndAsync()
	$out = $p.StandardOutput.ReadToEnd()
	if ($p.WaitForExit(60000)) { $c = "0x{0:x8}" -f $p.ExitCode } else { $p.Kill(); $c = "hang" }
	$verdict = ""
	$m = [regex]::Matches($out, "cap-h264-self-test:(\S+)")
	if ($m.Count -gt 0) { $verdict = " verdict=" + $m[$m.Count - 1].Groups[1].Value }
	$key = "$c$verdict"
	if ($errTask.Result -match "terminate it in an unusual way|abnormal program termination") { $key = "$key+abort" }
	if ($i -eq 0) { Write-Host "first run: $key stdout: $($out.Trim() | Select-Object -First 1) stderr: $($errTask.Result.Trim())" }
	if ($codes.ContainsKey($key)) { $codes[$key]++ } else { $codes[$key] = 1 }
}
Start-Sleep 2
$dumpCount = @(Get-ChildItem $dumps -Filter *.dmp).Count
New-Item -ItemType Directory -Force "$env:RUNNER_TEMP\keep" | Out-Null
Get-ChildItem $dumps -Filter *.dmp | Select-Object -First 2 | Copy-Item -Destination "$env:RUNNER_TEMP\keep"
$summary = ($codes.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join " "
$summary += " WER dumps=$dumpCount"
$line = "| $env:RUNNER_LABEL | $Label | $N | $summary | {0:N0} s |" -f $sw.Elapsed.TotalSeconds
Write-Host $line
Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $line
Add-Content -Path "$env:RUNNER_TEMP\results.md" -Value $line
