# CK scratch (never ships): Cap Notes in a real remote desktop session on a hosted Windows runner.
# A second local user is signed in over RDP from this machine's own console (mstsc to 127.0.0.2,
# audio "play on this computer"), so that session's output is the redirected "Remote Audio".
# Each arm (env CK_RDP_ARMS, "name=exe" pairs) runs one meeting inside that session through a
# schtasks /it task (rdpinner.ps1): NVDA speaking, the stand-in call on the default output.
$ErrorActionPreference = 'Continue'
$Here = $PSScriptRoot
$Root = (Resolve-Path "$Here\..").Path
$Fix = "$Root\apps\desktop-gpui\tests\fixtures\meetings"
$Work = 'C:\ck'
New-Item -ItemType Directory -Force $Work, "$Work\page" | Out-Null
$py = (Get-Command python).Source
"os: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version)" | Tee-Object "$Work\machine.txt"
Copy-Item "$Here\call.html" "$Work\page\"
ffmpeg -v error -y -i "$Fix\others.opus" -ac 2 -ar 48000 -c:a pcm_s16le "$Work\page\others.wav"
Copy-Item "$Fix\truth.json" "$Work\meeting-truth.json"
$serveLog = "$Work\page.log"
$server = Start-Process -PassThru -WindowStyle Hidden $py -ArgumentList "`"$Here\serve.py`" `"$Work\page`" 8765 `"$serveLog`""
$chrome = @('C:\Program Files\Google\Chrome\Application\chrome.exe', 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not (Get-Module -ListAvailable AudioDeviceCmdlets)) {
  Set-PSRepository PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
  Install-Module AudioDeviceCmdlets -Force -Scope AllUsers -AllowClobber
}
Copy-Item "$Here\rdpinner.ps1" "$Work\i.ps1"

# The RDP user and the session.
$pw = 'Ck' + [guid]::NewGuid().ToString('N').Substring(0, 14) + '!a1'
New-LocalUser -Name ckrdp -Password (ConvertTo-SecureString $pw -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires | Out-Null
Add-LocalGroupMember -Group Administrators -Member ckrdp
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member ckrdp
"user: $((Get-LocalUser ckrdp).Name) enabled=$((Get-LocalUser ckrdp).Enabled)" | Tee-Object -Append "$Work\summary.txt"
icacls $Work /grant "ckrdp:(OI)(CI)F" /T | Out-Null
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 0
New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' -Name fDisableCam -Value 0
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' -Name fSingleSessionPerUser -Value 0
Start-Service TermService -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
cmdkey /generic:TERMSRV/127.0.0.2 /user:ckrdp /pass:$pw | Out-Null
# No .rdp file (an unsigned one opens a publisher warning) and no certificate warning; audio then
# defaults to "play on this computer".
New-Item -Force 'HKCU:\Software\Microsoft\Terminal Server Client' | Out-Null
Set-ItemProperty 'HKCU:\Software\Microsoft\Terminal Server Client' -Name AuthenticationLevelOverride -Value 0 -Type DWord
function Shot($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save("$Work\$name.png", [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  } catch { "shot ${name}: $_" | Add-Content "$Work\summary.txt" }
}
Start-Process mstsc -ArgumentList '/v:127.0.0.2', '/w:1280', '/h:800'
$active = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 3
  $q = (query session 2>&1 | Out-String)
  if ($q -match 'ckrdp\s+\d+\s+Active') { $active = $true; break }
  if ($i -eq 10) { Shot 'rdp-30s' }
}
query session 2>&1 | Out-String | Tee-Object "$Work\sessions.txt"
if (-not $active) { Shot 'rdp-failed'; 'RDP SESSION NOT ACTIVE' | Tee-Object -Append "$Work\summary.txt"; Get-Process mstsc -ErrorAction SilentlyContinue | Format-Table Id, SessionId, MainWindowTitle | Out-String | Tee-Object -Append "$Work\summary.txt"; Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational' -MaxEvents 10 -ErrorAction SilentlyContinue | Format-Table TimeCreated, Id, Message -Wrap | Out-String -Width 300 | Tee-Object -Append "$Work\summary.txt"; exit 2 }
"rdp session active after $(3 * ($i + 1)) s" | Tee-Object -Append "$Work\summary.txt"
Start-Sleep -Seconds 20

foreach ($pair in ($env:CK_RDP_ARMS -split ' ')) {
  $arm, $bin = $pair -split '=', 2
  $R = "$Work\$arm"
  New-Item -ItemType Directory -Force $R | Out-Null
  @{ R = $R; bin = $bin; py = $py; stub = "$Root\scripts\ci\meetings\stub_server.py"; models = $env:CAP_MEETINGS_MODELS;
     nvda = $env:CD_NVDA; nvdaClient = $env:CD_NVDA_CLIENT; chrome = $chrome; pageLog = $serveLog; secs = 70; talk = 55 } |
    ConvertTo-Json | Set-Content -Encoding ascii "$Work\$arm.json"
  schtasks /create /tn "ck$arm" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ck\i.ps1 C:\ck\$arm.json" /sc once /st 23:59 /ru ckrdp /rp $pw /it /f | Out-Null
  schtasks /run /tn "ck$arm" | Out-Null
  for ($i = 0; $i -lt 200; $i++) { if (Test-Path "$R\done.txt") { break }; Start-Sleep -Seconds 3 }
  if (-not (Test-Path "$R\done.txt")) { "[$arm] inner run never finished" | Tee-Object -Append "$Work\summary.txt" }
  Get-Content "$R\session.txt" -ErrorAction SilentlyContinue | ForEach-Object { "[$arm] $_" } | Tee-Object -Append "$Work\summary.txt"
  if (Test-Path "$R\app.log") {
    & $py "$Here\report.py" $R | Set-Content "$R\report.txt"
    $marks = Get-Content "$R\timeline.txt"
    $t0 = [double](($marks | Select-Object -First 1) -split ' ')[0]
    $callAt = $marks | Where-Object { $_ -match 'call plays' } | Select-Object -First 1
    $offset = if ($callAt) { ([double]($callAt -split ' ')[0] - $t0) / 1000 } else { 0 }
    & $py "$Here\score.py" $R "$Work\meeting-truth.json" $offset | Add-Content "$R\report.txt"
    & $py "$Here\nwords.py" $R | Add-Content "$R\report.txt"
    & $py "$Here\captsys.py" $R | Add-Content "$R\report.txt"
    Get-Content "$R\report.txt" | Select-String 'recall|final lines|reader words|computer audio capture|exited early' | ForEach-Object { "[$arm] $_" } | Tee-Object -Append "$Work\summary.txt"
    Select-String -Path "$R\app.log" -Pattern 'remote desktop|screen reader|left out|stayed silent|default output|panicked|could not' | Select-Object -First 10 | ForEach-Object { "[$arm] log: $($_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)))" } | Tee-Object -Append "$Work\summary.txt"
    "[$arm] panics: $((Select-String -Path "$R\app.log" -Pattern 'panicked' | Measure-Object).Count)" | Tee-Object -Append "$Work\summary.txt"
  }
  schtasks /delete /tn "ck$arm" /f | Out-Null
}
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Get-Content "$Work\summary.txt"
exit 0
