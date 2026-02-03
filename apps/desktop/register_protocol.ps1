$ExePath = "C:\DEV\AG-Workspace\BountyHunter\Cap\target\debug\cap-desktop.exe"
$Protocol = "cap"

if (-not (Test-Path $ExePath)) {
    Write-Host "Error: cap-desktop.exe not found at $ExePath" -ForegroundColor Red
    exit
}

Write-Host "Registering $($Protocol):// protocol to: $ExePath"

# HKEY_CLASSES_ROOT
$RegPath = "HKCU:\Software\Classes\$Protocol"
if (-not (Test-Path $RegPath)) { New-Item -Path $RegPath -Force }
New-ItemProperty -Path $RegPath -Name "URL Protocol" -Value "" -PropertyType String -Force

$ShellPath = "$RegPath\shell\open\command"
if (-not (Test-Path $ShellPath)) { New-Item -Path $ShellPath -Force }
Set-Item -Path $ShellPath -Value "`"$ExePath`" `"%1`""

Write-Host "✅ Protocol $($Protocol):// registered successfully!" -ForegroundColor Green
Write-Host "You can now test it by running: start $($Protocol)://record"
