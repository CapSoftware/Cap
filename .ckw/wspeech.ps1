# wspeech.ps1 -Work <dir> (builder CD, from BS's comms.ps1): Windows call-output scenarios through the real app, base and head binaries
# ($env:BS_BIN_BASE, $env:BS_BIN_HEAD) on the same machine and inputs. Scratch, never ships.
#
# Devices: the VB-Audio cable (its Speakers the default output; "CABLE Output" the microphone,
# which hears whatever plays on the cable) and VoiceMeeter's input (a second output, the default
# communications device). Calls: call.html in Chrome or Edge (WebRTC, holds the microphone) and
# duplex.py (a native app, WASAPI shared or exclusive). $env:BS_CASES picks the cases.
param([string]$Work)
$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$Root = (Resolve-Path "$Here\..").Path
$Fix = "$Root\apps\desktop-gpui\tests\fixtures\meetings"
$Models = $env:CAP_MEETINGS_MODELS
$py = (Get-Command python).Source
New-Item -ItemType Directory -Force $Work | Out-Null
function Epoch { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
$Cases = if ($env:BS_CASES) { $env:BS_CASES -split ' ' } else { @() }
"os: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version) cores=$([Environment]::ProcessorCount) ram=$([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)) GB" | Tee-Object "$Work\machine.txt"

# Audio for the call page and the players.
$Page = "$Work\page"; New-Item -ItemType Directory -Force $Page | Out-Null
Copy-Item "$Here\call.html" $Page
ffmpeg -v error -y -i "$Fix\others.opus" -ac 2 -ar 48000 -c:a pcm_s16le "$Page\others.wav"
ffmpeg -v error -y -i "$Fix\others.opus" -ac 2 -ar 48000 -c:a pcm_s16le "$Work\others.wav"
ffmpeg -v error -y -i "$Fix\you.opus" -ac 2 -ar 48000 -c:a pcm_s16le "$Work\youonly.wav"
Copy-Item "$Fix\truth.json" "$Work\meeting-truth.json"
foreach ($f in "$Page\others.wav", "$Work\others.wav", "$Work\youonly.wav") { if (-not (Test-Path $f)) { "RIG BROKEN: $f missing" | Tee-Object -Append "$Work\summary.txt"; exit 1 } }
$M = "$([Environment]::GetFolderPath('LocalApplicationData'))\so.cap.desktop\transcription_models"
New-Item -ItemType Directory -Force $M | Out-Null
Get-ChildItem $Models | ForEach-Object {
  if (Test-Path "$M\$($_.Name)") { return }
  if ($_.PSIsContainer) { cmd /c mklink /J "$M\$($_.Name)" $_.FullName | Out-Null } else { Copy-Item $_.FullName $M\ }
}
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
$edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
$serveLog = "$Work\page.log"
$server = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList "`"$Here\serve.py`" `"$Page`" 8765 `"$serveLog`""

# The second output.
if (-not (Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*VoiceMeeter*' })) {
  $vm = "$env:TEMP\voicemeeter"; New-Item -ItemType Directory -Force $vm | Out-Null
  foreach ($name in 'VoicemeeterSetup_v1130.zip', 'VoicemeeterSetup_v1122.zip') {
    try { Invoke-WebRequest -UseBasicParsing "https://download.vb-audio.com/Download_CABLE/$name" -OutFile "$vm\vm.zip"; break } catch { "download $name failed" | Add-Content "$Work\devices.txt" }
  }
  Expand-Archive -Force "$vm\vm.zip" "$vm\pack"
  Get-ChildItem -Recurse "$vm\pack" -Filter *.cat | ForEach-Object {
    $signer = (Get-AuthenticodeSignature $_.FullName).SignerCertificate
    if ($signer) { [IO.File]::WriteAllBytes("$vm\signer.cer", $signer.Export('Cert')); certutil -addstore TrustedPublisher "$vm\signer.cer" | Out-Null }
  }
  $exe = Get-ChildItem -Recurse "$vm\pack" -Filter 'voicemeeterSetup*.exe' | Select-Object -First 1
  Start-Process -Wait -FilePath $exe.FullName -ArgumentList '-i', '-h'
  Start-Sleep -Seconds 8
}
if (-not (Get-Module -ListAvailable AudioDeviceCmdlets)) {
  Install-PackageProvider NuGet -Force -Scope CurrentUser | Out-Null
  Install-Module AudioDeviceCmdlets -Force -Scope CurrentUser -AllowClobber
}
Import-Module AudioDeviceCmdlets
& $py -m pip install -q sounddevice soundfile numpy 2>&1 | Out-Null
$speakers = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*Virtual Cable*' } | Select-Object -First 1
$second = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Playback' -and $_.Name -like '*VoiceMeeter*' -and $_.Name -notlike '*Aux*' } | Select-Object -First 1
$cableMic = Get-AudioDevice -List | Where-Object { $_.Type -eq 'Recording' -and $_.Name -like 'CABLE Output*' } | Select-Object -First 1
$secondEndpoint = Get-PnpDevice -Class AudioEndpoint | Where-Object { $_.FriendlyName -like 'VoiceMeeter Input*' } | Select-Object -First 1
$secondPart = ($second.Name -split ' \(')[0]
function Roles($default, $comms) {
  Set-AudioDevice -ID $default.ID -DefaultOnly | Out-Null
  Set-AudioDevice -ID $comms.ID -CommunicationOnly | Out-Null
  if ($cableMic) { Set-AudioDevice -ID $cableMic.ID | Out-Null }
}
function Devices($label) {
  "--- $label" | Add-Content "$Work\devices.txt"
  Get-AudioDevice -List | Format-Table Index, Type, Default, DefaultCommunication, Name, ID -AutoSize | Out-String -Width 400 | Add-Content "$Work\devices.txt"
}
Roles $speakers $second
Devices 'setup'
if (-not $second) { 'NO SECOND OUTPUT' | Tee-Object -Append "$Work\devices.txt"; exit 1 }

function Mark($R, $what) { "$(Epoch) $what" | Add-Content "$R\timeline.txt"; Write-Host "[$(Split-Path -Leaf $R)] $what" }

$script:procs = @()
function Browser($R, $exe, $query) {
  $dir = "$R\browser"
  $bargs = @("--user-data-dir=`"$dir`"", '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--window-position=0,500', '--window-size=700,400', "http://localhost:8765/call.html?$query")
  $before = (Get-Content $serveLog -ErrorAction SilentlyContinue | Measure-Object).Count
  Start-Process $exe -ArgumentList $bargs | Out-Null
  for ($i = 0; $i -lt 150; $i++) {
    $new = Get-Content $serveLog -ErrorAction SilentlyContinue | Select-Object -Skip $before
    $hit = $new | Where-Object { $_ -match ' call playing$' } | Select-Object -First 1
    if ($hit) { "$(($hit -split ' ')[0]) call plays ($query)" | Add-Content "$R\timeline.txt"; break }
    Start-Sleep -Milliseconds 200
  }
  Get-Content $serveLog -ErrorAction SilentlyContinue | Select-Object -Skip $before | Add-Content "$R\page.txt"
  $script:browserDirs += $dir
}
function Native($R, $wav, $part, $loops, [switch]$Exclusive, [switch]$NoMic, [switch]$IsCall) {
  $a = @("`"$Here\duplex.py`"", "`"$wav`"", "`"$part`"", $loops)
  if ($Exclusive) { $a += '--exclusive' }
  if ($NoMic) { $a += '--no-mic' }
  $p = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList $a -RedirectStandardOutput "$R\native-$($script:procs.Count).out" -RedirectStandardError "$R\native-$($script:procs.Count).err"
  $script:procs += $p
  if ($IsCall) { Mark $R "call plays (native $part)" } else { Mark $R "other app plays $wav to $part" }
}

function Meeting($Case, $Build, $Bin, $Secs, [scriptblock]$Timeline, [switch]$Voice) {
  $R = "$Work\$Case-$Build"
  New-Item -ItemType Directory -Force "$R\data\meetings", "$R\logs" | Out-Null
  $script:browserDirs = @(); $script:procs = @()
  '{"enabled": true, "setupCompleted": true, "transcription": {"engine": "local", "live": true}}' | Set-Content -Encoding ascii "$R\data\meetings\settings.json"
  "{`"general_settings`":{`"hasCompletedOnboarding`":true,`"hasCompletedStartup`":true,`"enableNotifications`":false,`"enableTelemetry`":false,`"recordingCountdown`":0,`"serverUrl`":`"http://127.0.0.1:8899`"},`"auth`":{`"secret`":{`"api_key`":`"ci-test-key`"},`"user_id`":`"citestuser0001`",`"plan`":{`"upgraded`":true,`"manual`":false,`"last_checked`":$([DateTimeOffset]::Now.ToUnixTimeSeconds())},`"organizations`":[]}}" | Set-Content -Encoding ascii "$R\data\store"
  $stub = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList "`"$Root\scripts\ci\meetings\stub_server.py`" 8899 `"$R\stub.jsonl`""
  Start-Sleep -Seconds 1
  $player = $null
  if ($Voice) { $player = New-Object System.Media.SoundPlayer "$Work\youonly.wav"; $player.PlayLooping() }
  $env:CAP_GPUI_APP_DATA_DIR = "$R\data"; $env:CAP_GPUI_LOG_DIR = "$R\logs"; $env:CAP_GPUI_NO_TRAY = '1'
  $env:RUST_LOG = 'warn,cap_gpui=info,cap_meetings=info,cap_meeting_platform=debug'
  $env:CAP_GPUI_AUTO_MEETING = "$Secs"; $env:CAP_GPUI_AUTO_MEETING_LINGER = '5'
  $env:CAP_GPUI_AUTO_MEETING_OUT = "$R\summary.json"
  Remove-Item Env:\CAP_GPUI_AUTO_MEETING_MIC_SCRIPT -ErrorAction SilentlyContinue
  $p = Start-Process -PassThru -FilePath $Bin -RedirectStandardOutput "$R\app.out" -RedirectStandardError "$R\app.err"
  if ($env:BS_AFFINITY) { try { $p.ProcessorAffinity = [IntPtr][int]$env:BS_AFFINITY } catch { Mark $R "affinity failed: $_" } }
  $log = "$R\logs\cap-gpui.log*"
  for ($i = 0; $i -lt 900; $i++) { if (Select-String -Quiet -Path $log -Pattern 'CAP_GPUI_AUTO_MEETING: (recording|start failed)' -ErrorAction SilentlyContinue) { break }; if ($p.HasExited) { break }; Start-Sleep -Milliseconds 100 }
  if (-not (Select-String -Quiet -Path $log -Pattern 'CAP_GPUI_AUTO_MEETING: recording' -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue
    Get-Content "$R\logs\cap-gpui.log*" -ErrorAction SilentlyContinue | Set-Content "$R\app.log"
    "RIG BROKEN: [$Case-$Build] the app never started recording" | Tee-Object -Append "$Work\summary.txt"; exit 1
  }
  Mark $R 'recording'
  $sampler = Start-Job -ArgumentList $p.Id, "$R\usage.txt" -ScriptBlock {
    param($id, $out)
    while ($true) {
      $q = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $q) { break }
      "{0} {1:F2} {2} {3}" -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $q.CPU, $q.WorkingSet64, $q.Threads.Count | Add-Content $out
      Start-Sleep -Seconds 5
    }
  }
  & $Timeline $R
  $deadline = (Get-Date).AddSeconds($Secs + 240)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path "$R\summary.json") -and (Get-Item "$R\summary.json").Length -gt 0) { break }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 300
  }
  Mark $R 'summary'
  Stop-Job $sampler -ErrorAction SilentlyContinue; Remove-Job $sampler -Force -ErrorAction SilentlyContinue
  if ($p.HasExited -and -not (Test-Path "$R\summary.json")) { Mark $R ("app exited early, code 0x{0:X8}" -f $p.ExitCode) }
  if ($player) { $player.Stop() }
  foreach ($x in $script:procs) { Stop-Process -Id $x.Id -Force -ErrorAction SilentlyContinue }
  foreach ($d in $script:browserDirs) {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$d*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  foreach ($x in @($p, $stub)) { Stop-Process -Id $x.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Get-Content "$R\logs\cap-gpui.log*" | Set-Content "$R\app.log"
  if (Test-Path "$R\app.err") { "--- stderr ---" | Add-Content "$R\app.log"; Get-Content "$R\app.err" -Tail 60 | Add-Content "$R\app.log" }
  & $py "$Here\report.py" $R | Set-Content "$R\report.txt"
  if (Test-Path "$R\usage.txt") {
    $u = Get-Content "$R\usage.txt" | ForEach-Object { $f = $_ -split ' '; [pscustomobject]@{ T = [double]$f[0]; C = [double]$f[1]; M = [double]$f[2] } }
    if ($u.Count -ge 2) {
      $cpu = ($u[-1].C - $u[0].C) / (($u[-1].T - $u[0].T) / 1000) * 100
      "cpu {0:F1}% of one core over {1:F0} s, peak working set {2:F0} MB" -f $cpu, (($u[-1].T - $u[0].T) / 1000), (($u | Measure-Object M -Maximum).Maximum / 1MB) | Add-Content "$R\report.txt"
    }
  }
  $marks = Get-Content "$R\timeline.txt"
  $t0 = [double](($marks | Select-Object -First 1) -split ' ')[0]
  $callAt = $marks | Where-Object { $_ -match 'call plays' } | Select-Object -First 1
  $offset = if ($callAt) { ([double]($callAt -split ' ')[0] - $t0) / 1000 } else { 0 }
  & $py "$Here\score.py" $R "$Work\meeting-truth.json" $offset | Add-Content "$R\report.txt"
  Get-Content "$R\report.txt" | Select-String 'recall|cpu |final lines|follows|back on the default|call.s output|exited early|panicked' | ForEach-Object { "[$Case-$Build] $_" } | Tee-Object -Append "$Work\summary.txt"
  Roles $speakers $second
}

function Both($Case, $Secs, [scriptblock]$Timeline, [switch]$Voice) {
  if ($Cases.Count -and ($Cases -notcontains $Case)) { return }
  $order = if ($script:flip) { @('head', 'base') } else { @('base', 'head') }
  $script:flip = -not $script:flip
  foreach ($b in $order) {
    $bin = if ($b -eq 'head') { $env:BS_BIN_HEAD } else { $env:BS_BIN_BASE }
    if (-not $bin) { continue }
    Meeting $Case $b $bin $Secs $Timeline -Voice:$Voice
  }
}



# ---- builder CK: NVDA on the output a call is followed to (appended to BS/CD's rig preamble) ----
# The call plays on the communications output (VoiceMeeter) while the speakers stay the default,
# so Cap follows the call there. NVDA talks through its controller client every 2.5 s, either on
# that same output (shared) or on the default (apart). Reader words and call recall are counted
# in the meeting's computer audio, base vs head. $env:CK_CASES picks the cases.
$CkCases = if ($env:CK_CASES) { $env:CK_CASES -split ' ' } else { @('nvda-shared', 'nvda-apart', 'nosr-comms') }
$secondId = $second.ID
function NvdaConfig($dir, $device) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $speech = "[speech]`r`n`tsynth = espeak`r`n"
  $audio = ''
  if ($device) {
    $speech += "`toutputDevice = $($second.Name)`r`n"
    $audio = "[audio]`r`n`toutputDevice = $device`r`n"
  }
  "[general]`r`n`tshowWelcomeDialogAtStartup = False`r`n$speech$audio" | Set-Content -Encoding ascii "$dir\nvda.ini"
}
NvdaConfig "$Work\nvda-shared" $secondId
NvdaConfig "$Work\nvda-apart" $null
function NvdaOn($cfg) { Start-Process $env:CD_NVDA -ArgumentList '-c', $cfg; Start-Sleep -Seconds 12 }
function NvdaOff { Start-Process -Wait $env:CD_NVDA -ArgumentList '-q' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Stop-Process -Name nvda -Force -ErrorAction SilentlyContinue }
function NvdaTalk($R, $secs) {
  Mark $R "nvda talks $secs s"
  $job = Start-Job -ArgumentList $env:CD_NVDA_CLIENT, $secs -ScriptBlock {
    param($dll, $secs)
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CkNvda {
  [DllImport(@"$dll", CharSet = CharSet.Unicode)] public static extern int nvdaController_speakText(string text);
}
"@
    $end = (Get-Date).AddSeconds($secs)
    while ((Get-Date) -lt $end) { [void][CkNvda]::nvdaController_speakText("the screen reader reads this line aloud"); Start-Sleep -Milliseconds 2500 }
  }
  $script:talkers += @(@{ Job = $job; Np = $null })
}
function Sessions($R) {
  $script:probe = Start-Job -ArgumentList "$Here\sessprobe.ps1", "$R\sessions.txt" -ScriptBlock {
    param($probe, $out)
    & $probe -Seconds 20 -Out $out | Out-Null
  }
}
$script:talkers = @()
function CkCase($Case, $Builds, $Secs, [scriptblock]$Timeline, [string]$Cfg) {
  if ($CkCases -notcontains $Case) { return }
  foreach ($b in $Builds) {
    $bin = if ($b -eq 'head') { $env:BS_BIN_HEAD } else { $env:BS_BIN_BASE }
    if ($Cfg) { NvdaOn $Cfg }
    Meeting $Case $b $bin $Secs $Timeline
    foreach ($t in $script:talkers) { Stop-Job $t.Job -ErrorAction SilentlyContinue; Remove-Job $t.Job -Force -ErrorAction SilentlyContinue }
    $script:talkers = @()
    if ($script:probe) { Wait-Job $script:probe -Timeout 30 | Out-Null; Remove-Job $script:probe -Force -ErrorAction SilentlyContinue; $script:probe = $null }
    if ($script:churn) { Wait-Job $script:churn -Timeout 30 | Out-Null; Remove-Job $script:churn -Force -ErrorAction SilentlyContinue; $script:churn = $null }
    if ($Cfg) { NvdaOff }
    $R = "$Work\$Case-$b"
    & $py "$Here\nwords.py" $R | Tee-Object -Append "$R\report.txt" | ForEach-Object { "[$Case-$b] $_" } | Tee-Object -Append "$Work\summary.txt"
    & $py "$Here\tone440.py" $R | ForEach-Object { "[$Case-$b] $_" } | Tee-Object -Append "$Work\summary.txt"
    & $py "$Here\captsys.py" $R | ForEach-Object { "[$Case-$b] $_" } | Tee-Object -Append "$Work\summary.txt"
    if (Test-Path "$R\sessions.txt") { Get-Content "$R\sessions.txt" | ForEach-Object { "[$Case-$b] heard: $_" } | Tee-Object -Append "$Work\summary.txt" }
    $switches = (Select-String -Path "$R\app.log" -Pattern 'only the call is read|left out of computer audio|default output is read as before|read as before|follows the call' | Measure-Object).Count
    "[$Case-$b] loopback switch log lines: $switches" | Tee-Object -Append "$Work\summary.txt"
    Select-String -Path "$R\app.log" -Pattern 'screen reader|follows the call|only the call|another output' | Select-Object -First 8 | ForEach-Object { "[$Case-$b] log: $($_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)))" } | Tee-Object -Append "$Work\summary.txt"
  }
}
"second output: $($second.Name) id $secondId" | Tee-Object -Append "$Work\summary.txt"
# Builder CK round 3: music (a 440 Hz tone) on the second output while the call, or other sound with
# no call, plays on the default output.
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=90" -ac 2 -c:a pcm_s16le "$Work\music.wav"
ffmpeg -v error -y -i "$Fix\others.opus" -ac 2 -ar 48000 -c:a pcm_s16le "$Work\othersonly.wav"
$speakersPart = ($speakers.Name -split ' \(')[0]
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" -ac 2 -c:a pcm_s16le "$Work\music6.wav"
# Music on the second output for 6 s, then 6 s of nothing, 10 times (2 min): the other output
# starts and stops playing while the meeting records.
function Churn($R) {
  $script:churn = Start-Job -ArgumentList $py, "$Here\duplex.py", "$Work\music6.wav", $secondPart, "$R\timeline.txt" -ScriptBlock {
    param($py, $duplex, $wav, $part, $timeline)
    for ($i = 1; $i -le 10; $i++) {
      "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) music on $i" | Add-Content $timeline
      & $py $duplex $wav $part 1 --no-mic | Out-Null
      "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) music off $i" | Add-Content $timeline
      Start-Sleep -Seconds 6
    }
  }
}
foreach ($round in 1, 2) {
  # NVDA and the call on the default output, music on the second output: base records the
  # music too, head only the call.
  CkCase 'nvda-music-call' @('base', 'head') 60 { param($R) Browser $R $chrome 'sink=default'; Native $R "$Work\music.wav" $secondPart 1 -NoMic; NvdaTalk $R 45 } "$Work\nvda-apart"
  # The same with no call app (sound with no microphone on the default output): head reads the
  # default output as Cap does without the exclusion.
  CkCase 'nvda-music-nocall' @('base', 'head') 60 { param($R) Mark $R 'call plays (none)'; Native $R "$Work\othersonly.wav" $speakersPart 1 -NoMic; Native $R "$Work\music.wav" $secondPart 1 -NoMic; NvdaTalk $R 45 } "$Work\nvda-apart"
  # The second output starts and stops 10 times with NVDA and the call on the default output.
  CkCase 'nvda-music-churn' @('base', 'head') 150 { param($R) Browser $R $chrome 'sink=default'; Churn $R; NvdaTalk $R 140 } "$Work\nvda-apart"
  # The same without a reader.
  CkCase 'nosr-music-churn' @('base', 'head') 150 { param($R) Browser $R $chrome 'sink=default'; Churn $R } ''
  # Builder CK round 5: NVDA and the call on the default output, and a 440 Hz tone from the same
  # browser page (the call's own audio service) on the second output. Base reads the call's
  # process tree on every output and records the tone; head reads the default output as main.
  CkCase 'nvda-tab-elsewhere' @('base', 'head') 60 { param($R) Browser $R $chrome "sink=default&tone=$([uri]::EscapeDataString($secondPart))"; NvdaTalk $R 45 } "$Work\nvda-apart"
  # The same without a reader: the default output on both.
  CkCase 'nosr-tab-elsewhere' @('base', 'head') 60 { param($R) Browser $R $chrome "sink=default&tone=$([uri]::EscapeDataString($secondPart))" } ''
  # No reader: as before on both.
  CkCase 'nosr-music-call' @('base', 'head') 60 { param($R) Browser $R $chrome 'sink=default'; Native $R "$Work\music.wav" $secondPart 1 -NoMic } ''
  # NVDA on the call's output: base records NVDA with the call, head only the call.
  CkCase 'nvda-shared' @('base', 'head') 60 { param($R) Browser $R $chrome 'sink=communications'; Sessions $R; NvdaTalk $R 45 } "$Work\nvda-shared"
  # NVDA on the default output, the call followed elsewhere: as before on both.
  CkCase 'nvda-apart' @('base', 'head') 60 { param($R) Browser $R $chrome 'sink=communications'; Sessions $R; NvdaTalk $R 45 } "$Work\nvda-apart"
  # No reader, the call followed: as before on both.
  CkCase 'nosr-comms' @('base', 'head') 60 { param($R) Browser $R $chrome 'sink=communications' } ''
  Get-ChildItem $Work -Directory | Where-Object { $_.Name -match '^(nvda-shared|nvda-apart|nosr-comms|nvda-music-call|nvda-music-nocall|nosr-music-call|nvda-music-churn|nosr-music-churn|nvda-tab-elsewhere|nosr-tab-elsewhere)-(base|head)$' } | ForEach-Object { Rename-Item $_.FullName "$($_.FullName)-r$round" }
}
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Get-Content "$Work\summary.txt"
exit 0
