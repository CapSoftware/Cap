# Starts a test binary from PowerShell. Git Bash starts its child processes
# with Windows crash reporting off (SEM_NOGPFAULTERRORBOX), so a test that
# crashes under run.sh leaves no dump; PowerShell clears that mode.
$exe = $args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
$process = Start-Process -FilePath $exe -ArgumentList $rest -NoNewWindow -Wait -PassThru
exit $process.ExitCode
