# setup_audio.ps1: a virtual sound card on a Windows runner (hosted runners have none): the
# VB-Audio virtual cable, giving playback "Speakers (VB-Audio Virtual Cable)" (the default output,
# which the app records as computer audio) and capture "CABLE Output" (a microphone for the call
# page). The driver package's catalog signer is trusted first so it installs without a prompt.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$d = Join-Path $env:RUNNER_TEMP 'vbcable'
New-Item -ItemType Directory -Force $d | Out-Null
Invoke-WebRequest -UseBasicParsing 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip' -OutFile "$d\vbcable.zip"
Expand-Archive -Force "$d\vbcable.zip" "$d\pack"
$signer = (Get-AuthenticodeSignature "$d\pack\vbaudio_cable64_win7.cat").SignerCertificate
[IO.File]::WriteAllBytes("$d\signer.cer", $signer.Export('Cert'))
certutil -addstore TrustedPublisher "$d\signer.cer" | Out-Null
# The vendor's own silent installer creates the device and installs the driver.
Start-Process -Wait -FilePath "$d\pack\VBCABLE_Setup_x64.exe" -ArgumentList '-i', '-h'
Set-Service Audiosrv -StartupType Automatic; Start-Service Audiosrv
# A runner's user has never allowed microphone access, so Windows refuses the call page's
# microphone (NotAllowedError) and never records it in the consent store Cap reads to find the
# call. Someone in a call has it on: turn it on for this user, desktop apps included.
$consent = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
New-Item -Force $consent | Out-Null; Set-ItemProperty $consent Value Allow
New-Item -Force "$consent\NonPackaged" | Out-Null; Set-ItemProperty "$consent\NonPackaged" Value Allow
Start-Sleep -Seconds 3
$endpoints = Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' }
$endpoints | Select-Object FriendlyName, Status | Out-Host
if (-not ($endpoints | Where-Object { $_.FriendlyName -like '*VB-Audio*' })) { throw 'the virtual cable has no audio endpoint' }
