# CK scratch (never ships): one Cap Notes meeting run INSIDE a remote desktop session (started by
# rdp.ps1 through a schtasks /it task as the RDP user). Records whether this is a remote session
# (SM_REMOTESESSION) and the audio endpoints it sees, then NVDA, Cap's automatic meeting and the
# stand-in browser call, as wspeech.ps1's Meeting does on the console.
param([string]$ArgsFile)
$a = Get-Content $ArgsFile -Raw | ConvertFrom-Json
$R = $a.R
function Mark($what) { "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) $what" | Add-Content "$R\timeline.txt" }
$p = $null; $stub = $null; $nvda = $false
try {
  Add-Type -AssemblyName System.Windows.Forms
  "remote session (SM_REMOTESESSION): $([System.Windows.Forms.SystemInformation]::TerminalServerSession)" | Add-Content "$R\session.txt"
  "session id: $((Get-Process -Id $PID).SessionId) user: $env:USERNAME" | Add-Content "$R\session.txt"
  if ($a.adc) { Import-Module $a.adc -ErrorAction SilentlyContinue } else { Import-Module AudioDeviceCmdlets -ErrorAction SilentlyContinue }
  try {
    Get-AudioDevice -List | Format-Table Index, Type, Default, DefaultCommunication, Name -AutoSize | Out-String -Width 300 | Add-Content "$R\session.txt"
    "default playback: $((Get-AudioDevice -Playback).Name)" | Add-Content "$R\session.txt"
  } catch { "audio devices: $_" | Add-Content "$R\session.txt" }

  New-Item -ItemType Directory -Force "$R\data\meetings", "$R\logs" | Out-Null
  '{"enabled": true, "setupCompleted": true, "transcription": {"engine": "local", "live": true}}' | Set-Content -Encoding ascii "$R\data\meetings\settings.json"
  "{`"general_settings`":{`"hasCompletedOnboarding`":true,`"hasCompletedStartup`":true,`"enableNotifications`":false,`"enableTelemetry`":false,`"recordingCountdown`":0,`"serverUrl`":`"http://127.0.0.1:8899`"},`"auth`":{`"secret`":{`"api_key`":`"ci-test-key`"},`"user_id`":`"citestuser0001`",`"plan`":{`"upgraded`":true,`"manual`":false,`"last_checked`":$([DateTimeOffset]::Now.ToUnixTimeSeconds())},`"organizations`":[]}}" | Set-Content -Encoding ascii "$R\data\store"
  $stub = Start-Process -PassThru -WindowStyle Hidden $a.py -ArgumentList "`"$($a.stub)`" 8899 `"$R\stub.jsonl`""

  if ($a.nvda) {
    New-Item -ItemType Directory -Force "$R\nvda" | Out-Null
    "[general]`r`n`tshowWelcomeDialogAtStartup = False`r`n[speech]`r`n`tsynth = espeak`r`n" | Set-Content -Encoding ascii "$R\nvda\nvda.ini"
    Start-Process $a.nvda -ArgumentList '-c', "$R\nvda"
    Start-Sleep -Seconds 12
    $nvda = $true
  }

  $env:CAP_GPUI_APP_DATA_DIR = "$R\data"; $env:CAP_GPUI_LOG_DIR = "$R\logs"; $env:CAP_GPUI_NO_TRAY = '1'
  $env:RUST_LOG = 'warn,cap_gpui=info,cap_meetings=info,cap_meeting_platform=debug'
  $env:CAP_GPUI_AUTO_MEETING = "$($a.secs)"; $env:CAP_GPUI_AUTO_MEETING_LINGER = '5'
  $env:CAP_GPUI_AUTO_MEETING_OUT = "$R\summary.json"
  $env:CAP_MEETINGS_MODELS = $a.models
  $p = Start-Process -PassThru -FilePath $a.bin -RedirectStandardOutput "$R\app.out" -RedirectStandardError "$R\app.err"
  for ($i = 0; $i -lt 2400; $i++) { if (Select-String -Quiet -Path "$R\logs\cap-gpui.log*" -Pattern 'CAP_GPUI_AUTO_MEETING: (recording|start failed)' -ErrorAction SilentlyContinue) { break }; if ($p.HasExited) { break }; Start-Sleep -Milliseconds 100 }
  if (-not (Select-String -Quiet -Path "$R\logs\cap-gpui.log*" -Pattern 'CAP_GPUI_AUTO_MEETING: recording' -ErrorAction SilentlyContinue)) {
    "RIG BROKEN: the app never started recording" | Add-Content "$R\session.txt"
    throw 'no recording'
  }
  Mark 'recording'

  $before = (Get-Content $a.pageLog -ErrorAction SilentlyContinue | Measure-Object).Count
  Start-Process $a.chrome -ArgumentList @("--user-data-dir=`"$R\browser`"", '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--window-position=0,300', '--window-size=700,400', 'http://localhost:8765/call.html?sink=default') | Out-Null
  for ($i = 0; $i -lt 150; $i++) {
    $hit = Get-Content $a.pageLog -ErrorAction SilentlyContinue | Select-Object -Skip $before | Where-Object { $_ -match ' call playing$' } | Select-Object -First 1
    if ($hit) { "$(($hit -split ' ')[0]) call plays (sink=default)" | Add-Content "$R\timeline.txt"; break }
    Start-Sleep -Milliseconds 200
  }
  Get-Content $a.pageLog -ErrorAction SilentlyContinue | Select-Object -Skip $before | Add-Content "$R\page.txt"

  if ($nvda) {
    Mark "nvda talks $($a.talk) s"
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CkNvdaR {
  [DllImport(@"$($a.nvdaClient)", CharSet = CharSet.Unicode)] public static extern int nvdaController_speakText(string text);
}
"@
    $end = (Get-Date).AddSeconds([int]$a.talk)
    while ((Get-Date) -lt $end) { [void][CkNvdaR]::nvdaController_speakText("the screen reader reads this line aloud"); Start-Sleep -Milliseconds 2500 }
  }
  $deadline = (Get-Date).AddSeconds([int]$a.secs + 240)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path "$R\summary.json") -and (Get-Item "$R\summary.json").Length -gt 0) { break }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 300
  }
  Mark 'summary'
} catch {
  "inner error: $_" | Add-Content "$R\session.txt"
} finally {
  if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  if ($stub) { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$R\browser*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($nvda) { Start-Process -Wait $a.nvda -ArgumentList '-q' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Stop-Process -Name nvda -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Get-Content "$R\logs\cap-gpui.log*" -ErrorAction SilentlyContinue | Set-Content "$R\app.log"
  if (Test-Path "$R\app.err") { "--- stderr ---" | Add-Content "$R\app.log"; Get-Content "$R\app.err" -Tail 60 | Add-Content "$R\app.log" }
  "done" | Set-Content "$R\done.txt"
}
