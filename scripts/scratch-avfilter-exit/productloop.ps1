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
	$psi.Arguments = $Arguments.Replace("{i}", "$i")
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.RedirectStandardInput = $true
	if ($Request) { $psi.EnvironmentVariables["CAP_H264_SELF_TEST_REQUEST"] = $Request }
	$p = [Diagnostics.Process]::Start($psi)
	$p.StandardInput.Close()
	$errTask = $p.StandardError.ReadToEndAsync()
	$outTask = $p.StandardOutput.ReadToEndAsync()
	if ($p.WaitForExit(150000)) {
		$c = "0x{0:x8}" -f $p.ExitCode
	} else {
		$c = "hang"
		$cdb = "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64\cdb.exe"
		$sym = "srv*$env:RUNNER_TEMP\sym*https://msdl.microsoft.com/download/symbols"
		Write-Host "=== hung pid $($p.Id) run $i"
		& $cdb -pv -p $p.Id -y $sym -c "~*kn 14; q" 2>&1 | Select-String "^\s*[0-9a-f]{2} [0-9a-f]{8}|^\s*[.#]\s*[0-9]+\s+Id:" | Select-Object -First 400 | ForEach-Object { Write-Host $_ }
		$p.Kill()
		$p.WaitForExit(10000) | Out-Null
	}
	$out = if ($outTask.Wait(5000)) { $outTask.Result } else { "" }
	$verdict = ""
	$m = [regex]::Matches($out, "cap-h264-self-test:(\S+)")
	if ($m.Count -gt 0) { $verdict = " verdict=" + $m[$m.Count - 1].Groups[1].Value }
	$key = "$c$verdict"
	if ($out -match "Exported video to") { $key = "$key exported" }
	if ($errTask.Result -match "terminate it in an unusual way|abnormal program termination") { $key = "$key+abort" }
	if ($i -eq 0) { Write-Host "first run: $key stdout: $($out.Trim() | Select-Object -First 1) stderr: $($errTask.Result.Trim())" }
	Write-Host "run $i $key $([int]$sw.Elapsed.TotalSeconds) s"
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
