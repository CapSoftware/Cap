# Probe only: two independent virtual capture endpoints on a hosted Windows
# runner (VB-Audio Virtual Cable and VB-Audio Hi-Fi Cable through devcon),
# plus devcon disable / enable of one to stand in for unplugging a USB mic.
#   win-audio.ps1 -Action install|list|unplug|replug [-Target "Hi-Fi"]
param([string]$Action = "list", [string]$Target = "Hi-Fi")
$ErrorActionPreference = "Stop"
$work = Join-Path $env:RUNNER_TEMP "winaudio"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$devcon = Join-Path $work "Scream\Install\helpers\devcon.exe"

function List-Endpoints {
    Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue |
        Format-Table -AutoSize Status, FriendlyName, InstanceId | Out-String -Width 300 | Write-Host
    Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like "ROOT\MEDIA\*" } |
        Format-Table -AutoSize Status, FriendlyName, InstanceId | Out-String -Width 300 | Write-Host
}

function Trust($file) {
    $sig = Get-AuthenticodeSignature $file
    Write-Host "$((Split-Path $file -Leaf)) signer $($sig.SignerCertificate.Subject) status $($sig.Status)"
    if ($sig.SignerCertificate) {
        $store = [System.Security.Cryptography.X509Certificates.X509Store]::new("TrustedPublisher", "LocalMachine")
        $store.Open("ReadWrite"); $store.Add($sig.SignerCertificate); $store.Close()
    }
}

function Install-Inf($dir, $pattern, $hwid) {
    $inf = Get-ChildItem $dir -Recurse -Filter $pattern | Where-Object { $_.Name -match "64" -and $_.Name -match "win10" } | Select-Object -First 1
    if (-not $inf) { $inf = Get-ChildItem $dir -Recurse -Filter $pattern | Where-Object { $_.Name -match "64" } | Select-Object -First 1 }
    if (-not $inf) { Get-ChildItem $dir -Recurse | Format-Table FullName | Out-String | Write-Host; throw "no inf in $dir" }
    Get-ChildItem $inf.Directory -Filter "*.cat" | ForEach-Object { Trust $_.FullName }
    Write-Host "installing $($inf.FullName) hwid $hwid"
    & $devcon install $inf.FullName $hwid
    if ($LASTEXITCODE -gt 1) { throw "devcon install $hwid failed $LASTEXITCODE" }
}

function Fetch($url, $out) {
    Invoke-WebRequest -UserAgent "Mozilla/5.0" -Uri $url -OutFile $out
    Write-Host "$out sha256 $((Get-FileHash -Algorithm SHA256 $out).Hash)"
}

function Root-Device($match) {
    Get-PnpDevice -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -like "ROOT\MEDIA\*" -and $_.FriendlyName -match [regex]::Escape($match) } |
        Select-Object -First 1
}


# What the Sound control panel's Disable / Enable does: IPolicyConfig's
# SetEndpointVisibility moves the endpoint to DEVICE_STATE_DISABLED (or back),
# which invalidates live streams and drops it from the active endpoint list.
function Set-Visibility($match, $visible) {
    if (-not ("ProbeEndpoint" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr f);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int d, IntPtr f);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a, IntPtr b);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int d, IntPtr a, IntPtr b);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr m);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr m);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr k, IntPtr v);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr k, IntPtr v);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class PolicyConfigClient {}
public static class ProbeEndpoint {
    public static int SetVisible(string id, int visible) {
        return ((IPolicyConfig)new PolicyConfigClient()).SetEndpointVisibility(id, visible);
    }
}
"@
    }
    $eps = @(Get-PnpDevice -Class AudioEndpoint | Where-Object { $_.FriendlyName -like "*$match*" })
    foreach ($e in $eps) {
        $id = $e.InstanceId -replace '^SWD\\MMDEVAPI\\', ''
        $hr = [ProbeEndpoint]::SetVisible($id, $visible)
        Write-Host ("visibility {0} {1} ({2}) hr=0x{3:X8}" -f $visible, $e.FriendlyName, $id, $hr)
    }
    Start-Sleep -Milliseconds 500
    Get-PnpDevice -Class AudioEndpoint | Format-Table -AutoSize Status, FriendlyName | Out-String -Width 200 | Write-Host
}

switch ($Action) {
    "install" {
        Push-Location $work
        Fetch https://github.com/duncanthrax/scream/releases/download/3.6/Scream3.6.zip Scream3.6.zip
        if ((Get-FileHash -Algorithm SHA256 Scream3.6.zip).Hash.ToLowerInvariant() -ne "25ea5e778b4e6995a98d448b9b5f6d321f681663f1aeeec69d8e63183d008b19") { throw "Scream3.6.zip SHA-256 mismatch" }
        Expand-Archive -Force -Path Scream3.6.zip -DestinationPath Scream
        Fetch https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip cable.zip
        Expand-Archive -Force -Path cable.zip -DestinationPath cable
        Fetch https://download.vb-audio.com/Download_CABLE/HiFiCableAsioBridgeSetup_v1007.zip hifi.zip
        Expand-Archive -Force -Path hifi.zip -DestinationPath hifi
        Get-ChildItem hifi -Recurse | Format-Table FullName, Length | Out-String -Width 200 | Write-Host
        Install-Inf cable "vbMmeCable64*.inf" "VBAudioVACWDM"
        # The Hi-Fi package only ships a setup program.
        if ($true) {
            $setup = Get-ChildItem hifi -Recurse -Filter "*Setup*x64*.exe" | Select-Object -First 1
            if (-not $setup) { $setup = Get-ChildItem hifi -Recurse -Filter "*Setup*.exe" | Select-Object -First 1 }
            Trust $setup.FullName
            Write-Host "running $($setup.FullName) -i -h"
            $p = Start-Process -FilePath $setup.FullName -ArgumentList "-i", "-h" -PassThru
            if (-not $p.WaitForExit(180000)) { $p.Kill(); throw "Hi-Fi setup hung" }
            Write-Host "setup exit $($p.ExitCode)"
        }
        Start-Service -Name Audiosrv -ErrorAction SilentlyContinue
        Start-Sleep 5
        Pop-Location
        List-Endpoints
    }
    "unplug" { Set-Visibility $Target 0 }
    "replug" { Set-Visibility $Target 1 }
    default { List-Endpoints }
}
