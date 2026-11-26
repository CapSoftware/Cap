# windows.ps1 -Bin <cap-gpui.exe> -Work <dir>: scripted meetings through the real app on Windows.
#
# Needs a signed-in desktop session (the hosted runner has one) and the VB-Audio virtual cable
# (setup_audio.ps1): its "Speakers" are the default output, which the app records as computer audio
# through WASAPI loopback; the stand-in call page in Chrome holds "CABLE Output" as its microphone
# like a call does and plays the meeting's other side. The box has one cable, so the microphone side
# goes through the app's scripted microphone. The account is a Pro account against stub_server.py.
#
# Cases: a Local meeting (notes window open, a question asked through the Ask bar with real input,
# and names for the call's voices read from the call page through UI Automation); a Cloud meeting;
# the live indicator's banner at the right edge of the screen; the notes window opened again through
# its shortcut and a meeting start stays one window, in front. Exit code 1 if any check fails.
param([string]$Bin, [string]$Work)
$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$Root = (Resolve-Path "$Here\..\..\..").Path
$Fix = "$Root\apps\desktop-gpui\tests\fixtures\meetings"
$Models = $env:CAP_MEETINGS_MODELS
$py = (Get-Command python).Source
New-Item -ItemType Directory -Force $Work | Out-Null
function Epoch { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot($path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path); $g.Dispose(); $bmp.Dispose()
}
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CapCi {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static void CtrlAlt(byte key) {
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
  public static List<string> Windows(uint pid) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      RECT r; GetWindowRect(h, out r);
      o.Add(String.Format("{0}|{1}|{2}|{3}|{4}|{5}", h, sb, r.L, r.T, r.R - r.L, r.B - r.T));
      return true; }, IntPtr.Zero);
    return o;
  }
}
"@
function AppWindows($procId) {
  [CapCi]::Windows([uint32]$procId) | ForEach-Object {
    $f = $_.Split('|'); [pscustomobject]@{ H = [IntPtr][long]$f[0]; Title = $f[1]; X = [int]$f[2]; Y = [int]$f[3]; W = [int]$f[4]; Hh = [int]$f[5] }
  }
}

# The meeting's audio as the app and the call page need it.
$Meet = "$Work\meeting"; New-Item -ItemType Directory -Force $Meet | Out-Null
ffmpeg -v error -y -i "$Fix\you.opus" -f f32le -ac 1 -ar 48000 "$Meet\mic.f32"
ffmpeg -v error -y -i "$Fix\others.opus" -ac 1 -ar 48000 -c:a pcm_s16le "$Meet\sys.wav"
Copy-Item "$Fix\truth.json" $Meet
$dur = [int]((Get-Content "$Meet\truth.json" -Raw | ConvertFrom-Json).duration_ms / 1000)
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) { $openssl = 'C:\Program Files\Git\usr\bin\openssl.exe' }
& $openssl req -x509 -newkey rsa:2048 -nodes -keyout "$Work\key.pem" -out "$Work\cert.pem" -days 2 -subj "/CN=meet.google.com" -addext "subjectAltName=DNS:meet.google.com" 2>$null
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1

# The app finds its models in the user's local app data (Known Folder, not the environment).
$M = "$([Environment]::GetFolderPath('LocalApplicationData'))\so.cap.desktop\transcription_models"
New-Item -ItemType Directory -Force $M | Out-Null
Get-ChildItem $Models | ForEach-Object {
  if (Test-Path "$M\$($_.Name)") { return }
  if ($_.PSIsContainer) { cmd /c mklink /J "$M\$($_.Name)" $_.FullName | Out-Null } else { Copy-Item $_.FullName $M\ }
}

function Meeting($Case, $Engine, $Ask) {
  $R = "$Work\$Case"
  New-Item -ItemType Directory -Force "$R\data\meetings", "$R\shots" | Out-Null
  "{`"enabled`": true, `"setupCompleted`": true, `"transcription`": {`"engine`": `"$Engine`", `"live`": true}}" | Set-Content -Encoding ascii "$R\data\meetings\settings.json"
  "{`"general_settings`":{`"hasCompletedOnboarding`":true,`"hasCompletedStartup`":true,`"enableNotifications`":false,`"enableTelemetry`":false,`"recordingCountdown`":0,`"serverUrl`":`"http://127.0.0.1:8899`"},`"auth`":{`"secret`":{`"api_key`":`"ci-test-key`"},`"user_id`":`"citestuser0001`",`"plan`":{`"upgraded`":true,`"manual`":false,`"last_checked`":$([DateTimeOffset]::Now.ToUnixTimeSeconds())},`"organizations`":[]}}" | Set-Content -Encoding ascii "$R\data\store"
  "3000 $Meet\mic.f32" | Set-Content -Encoding ascii "$R\mic_script.txt"
  $stub = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList "`"$Here\stub_server.py`" 8899 `"$R\stub.jsonl`""
  for ($i = 0; $i -lt 50; $i++) { if (Test-NetConnection 127.0.0.1 -Port 8899 -InformationLevel Quiet -WarningAction SilentlyContinue) { break }; Start-Sleep -Milliseconds 200 }
  $secs = $dur + 12; $linger = 70
  $env:CAP_GPUI_APP_DATA_DIR = "$R\data"; $env:CAP_GPUI_LOG_DIR = "$R\logs"; $env:CAP_GPUI_NO_TRAY = '1'
  $env:RUST_LOG = 'warn,cap_gpui=info,cap_meetings=info'; $env:CAP_GPUI_DOCS_OPEN = 'live'
  $env:CAP_GPUI_AUTO_MEETING = "$secs"; $env:CAP_GPUI_AUTO_MEETING_LINGER = "$linger"
  $env:CAP_GPUI_AUTO_MEETING_OUT = "$R\summary.json"; $env:CAP_GPUI_AUTO_MEETING_MIC_SCRIPT = "$R\mic_script.txt"
  $env:CAP_GPUI_AUTO_MEETING_MARKS = "$R\marks.txt"
  # The meeting's length counts from when the call page starts playing.
  $env:CAP_GPUI_AUTO_MEETING_STOP_FILE = "$R\page_started.log"
  New-Item -ItemType Directory -Force "$R\logs" | Out-Null
  $p = Start-Process -PassThru -FilePath $Bin -RedirectStandardOutput "$R\app.out" -RedirectStandardError "$R\app.err"
  $log = "$R\logs\cap-gpui.log*"
  for ($i = 0; $i -lt 900; $i++) { if (Select-String -Quiet -Path $log -Pattern 'CAP_GPUI_AUTO_MEETING: recording' -ErrorAction SilentlyContinue) { break }; if ($p.HasExited) { break }; Start-Sleep -Milliseconds 100 }
  $at = (Epoch) + 5000
  $server = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList "`"$Here\call_server.py`" `"$Meet`" 8443 `"$R\page_started.log`" --tls `"$Work\cert.pem`" `"$Work\key.pem`""
  Start-Sleep -Milliseconds 500
  if ($server.HasExited) { "the call page server did not start"; exit 1 }
  $cargs = @("--user-data-dir=`"$R\chrome`"", '--no-first-run', '--no-default-browser-check',
    '"--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:8443"', '--ignore-certificate-errors',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--window-position=0,520', '--window-size=900,500', "https://meet.google.com/abc-defg-hij?at=$at")
  $browser = Start-Process -PassThru $chrome -ArgumentList $cargs
  Start-Sleep -Seconds ([int]($dur / 2)); Shot "$R\shots\recording.png"
  $deadline = (Get-Date).AddSeconds($secs + $linger + 240); $asked = $false
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path "$R\summary.json") -and (Get-Item "$R\summary.json").Length -gt 0) { break }
    if ($p.HasExited) { break }
    if (-not $asked -and (Select-String -Quiet -Path $log -Pattern 'CAP_GPUI_AUTO_MEETING: drained' -ErrorAction SilentlyContinue)) {
      $asked = $true; Start-Sleep -Seconds 25; Shot "$R\shots\notes.png"
      if ($Ask) {
        $notes = AppWindows $p.Id | Where-Object { $_.Title -ne 'Cap' -and $_.Title -ne 'Cap Meeting Indicator' -and $_.X -gt -1000 -and $_.W -gt 500 } | Sort-Object { $_.W * $_.Hh } -Descending | Select-Object -First 1
        if ($notes) {
          [CapCi]::SetForegroundWindow($notes.H) | Out-Null; Start-Sleep -Milliseconds 400
          [CapCi]::Click($notes.X + [int]($notes.W * 0.62), $notes.Y + $notes.Hh - 40); Start-Sleep -Milliseconds 1500
          [System.Windows.Forms.SendKeys]::SendWait($Ask); Start-Sleep -Milliseconds 300
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          "asked $(Epoch)" | Add-Content "$R\run.txt"; Start-Sleep -Seconds 6; Shot "$R\shots\ask.png"
        } else { "no notes window" | Add-Content "$R\run.txt" }
      }
    }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Seconds 1
  foreach ($x in @($p, $stub, $server)) { Stop-Process -Id $x.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$R\chrome*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Content $log, "$R\app.err" -ErrorAction SilentlyContinue | Set-Content -Encoding utf8 "$R\app.log"
  $t0 = Get-Content "$R\marks.txt" -ErrorAction SilentlyContinue | Where-Object { $_ -like 't0 *' } | Select-Object -First 1
  if ($t0) { "mic $([long]($t0.Split(' ')[1]) + 3000)" | Add-Content "$R\run.txt" }
  $doc = & $py -c "import json;print(json.load(open(r'$R\summary.json'))['docDir'])" 2>$null
  & $py "$Here\offsets.py" $R $doc | Set-Content -Encoding ascii "$R\offsets.json"
  & $py "$Here\score.py" "$doc\transcript.jsonl" "$Meet\truth.json" "$R\offsets.json" 2> "$R\score.err" | Set-Content -Encoding ascii "$R\score.json"
  $env:CAP_EXPECT_APP_NAMES = '1'; $env:CAP_EXPECT_QUESTION = $Ask
  & $py "$Here\check.py" $R $doc $Engine $Meet | Tee-Object "$R\check.txt"
  Remove-Item Env:CAP_EXPECT_APP_NAMES, Env:CAP_EXPECT_QUESTION -ErrorAction SilentlyContinue
}

function Indicator {
  $R = "$Work\indicator"; New-Item -ItemType Directory -Force "$R\data" | Out-Null
  '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false}}' | Set-Content -Encoding ascii "$R\data\store"
  foreach ($k in 'CAP_GPUI_AUTO_MEETING', 'CAP_GPUI_AUTO_MEETING_MIC_SCRIPT', 'CAP_GPUI_AUTO_MEETING_STOP_FILE', 'CAP_GPUI_DOCS_OPEN') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  $env:CAP_GPUI_APP_DATA_DIR = "$R\data"; $env:CAP_GPUI_LOG_DIR = "$R\logs"; $env:CAP_GPUI_MEETING_UI = 'ind-ending'
  $p = Start-Process -PassThru -FilePath $Bin -WindowStyle Minimized
  Start-Sleep -Seconds 15; Shot "$R\indicator.png"
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
  $ind = AppWindows $p.Id | Where-Object { $_.Title -eq 'Cap Meeting Indicator' } | Select-Object -First 1
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item Env:CAP_GPUI_MEETING_UI
  if (-not $ind) { "FAIL indicator window found", "SOME_FAILED" | Tee-Object "$R\check.txt"; return }
  $ok = $ind.W -gt 160 -and $ind.X -ge 0 -and ($ind.X + $ind.W) -le $screen
  @("$(if ($ok) { 'PASS' } else { 'FAIL' }) banner on screen x=$($ind.X) w=$($ind.W) right=$($ind.X + $ind.W) screen=$screen",
    $(if ($ok) { 'ALL_PASS' } else { 'SOME_FAILED' })) | Tee-Object "$R\check.txt"
}

function NotesWindow {
  # Opening the notes window again (its shortcut, then a meeting start) raises the one that is
  # open: exactly one "Cap Notes" window, in front. Real key input, no hooks.
  $R = "$Work\notes-window"; New-Item -ItemType Directory -Force "$R\data\meetings", "$R\shots" | Out-Null
  '{"enabled": true, "setupCompleted": true, "transcription": {"engine": "local", "live": true}}' | Set-Content -Encoding ascii "$R\data\meetings\settings.json"
  '{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"hotkeys":{"hotkeys":{"openMeetingNotes":{"code":"KeyN","meta":false,"ctrl":true,"alt":true,"shift":false},"toggleMeetingNotes":{"code":"KeyY","meta":false,"ctrl":true,"alt":true,"shift":false}}}}' | Set-Content -Encoding ascii "$R\data\store"
  foreach ($k in 'CAP_GPUI_AUTO_MEETING', 'CAP_GPUI_AUTO_MEETING_MIC_SCRIPT', 'CAP_GPUI_DOCS_OPEN', 'CAP_GPUI_MEETING_UI') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  $env:CAP_GPUI_APP_DATA_DIR = "$R\data"; $env:CAP_GPUI_LOG_DIR = "$R\logs"
  $p = Start-Process -PassThru -FilePath $Bin
  Start-Sleep -Seconds 12
  $lines = @()
  function Look($label) {
    $all = @(AppWindows $p.Id)
    $notes = @($all | Where-Object { $_.Title -eq 'Cap Notes' })
    $front = [CapCi]::GetForegroundWindow()
    $inFront = @($notes | Where-Object { $_.H -eq $front }).Count -eq 1
    "$label notes=$($notes.Count) front=$inFront"
  }
  [CapCi]::CtrlAlt(0x4E); Start-Sleep -Seconds 3; $lines += Look 'open'
  $main = AppWindows $p.Id | Where-Object { $_.Title -eq 'Cap' } | Select-Object -First 1
  if ($main) { [CapCi]::SetForegroundWindow($main.H) | Out-Null }; Start-Sleep -Seconds 1
  [CapCi]::CtrlAlt(0x4E); Start-Sleep -Seconds 3; $lines += Look 'open-again'
  [CapCi]::CtrlAlt(0x59); Start-Sleep -Seconds 4; $lines += Look 'meeting'
  [CapCi]::CtrlAlt(0x59); Start-Sleep -Seconds 2
  Shot "$R\shots\notes-window.png"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  $ok = (@($lines | Where-Object { $_ -notmatch 'notes=1 front=True' }).Count -eq 0)
  ($lines | ForEach-Object { "$(if ($_ -match 'notes=1 front=True') { 'PASS' } else { 'FAIL' }) $_" }) + @($(if ($ok) { 'ALL_PASS' } else { 'SOME_FAILED' })) | Tee-Object "$R\check.txt"
}

Meeting 'local' 'local' 'What did Ana say about the plan?'
Meeting 'cloud' 'cloud' $null
Indicator
NotesWindow
$failed = 0
foreach ($c in 'local', 'cloud', 'indicator', 'notes-window') {
  if (-not (Select-String -Quiet -Path "$Work\$c\check.txt" -Pattern 'ALL_PASS' -ErrorAction SilentlyContinue)) { "case $c failed"; $failed = 1 }
}
exit $failed
