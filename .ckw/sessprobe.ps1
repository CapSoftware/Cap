# sessprobe.ps1 -Seconds <n> -Out <file>: every 250 ms, every active render endpoint's audio sessions
# with their process id, executable and meter peak; prints each (endpoint, pid, exe) that was heard
# (peak > 0.001) and in how many samples. Shows which process actually plays a screen reader's speech.
param([int]$Seconds = 20, [string]$Out)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection devices); }
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int n); int Item(int i, out IMMDevice d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IntPtr store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr a, int b, out IntPtr c); int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
  int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, [MarshalAs(UnmanagedType.IUnknown)] out object s); }
[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int s); int GetDisplayName(out IntPtr n); int SetDisplayName(IntPtr a, IntPtr b);
  int GetIconPath(out IntPtr p); int SetIconPath(IntPtr a, IntPtr b); int GetGroupingParam(out Guid g);
  int SetGroupingParam(IntPtr a, IntPtr b); int RegisterAudioSessionNotification(IntPtr a);
  int UnregisterAudioSessionNotification(IntPtr a);
  int GetSessionIdentifier(out IntPtr a); int GetSessionInstanceIdentifier(out IntPtr a);
  int GetProcessId(out uint pid);
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float peak); }
public static class CdSess {
  public static List<string> Look() {
    var list = new List<string>();
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
    IMMDeviceCollection devs; en.EnumAudioEndpoints(0, 1, out devs);
    int n; devs.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice d; devs.Item(i, out d); string id; d.GetId(out id);
      Guid g = typeof(IAudioSessionManager2).GUID; object o; d.Activate(ref g, 23, IntPtr.Zero, out o);
      var mgr = (IAudioSessionManager2)o; IAudioSessionEnumerator se; mgr.GetSessionEnumerator(out se);
      int c; se.GetCount(out c);
      for (int k = 0; k < c; k++) {
        object s; se.GetSession(k, out s);
        var ctl = (IAudioSessionControl2)s; uint pid; ctl.GetProcessId(out pid);
        float peak = 0; try { ((IAudioMeterInformation)s).GetPeakValue(out peak); } catch {}
        list.Add(id + "|" + pid + "|" + peak);
      }
    }
    return list;
  }
}
"@
$heard = @{}
$end = (Get-Date).AddSeconds($Seconds)
$samples = 0
while ((Get-Date) -lt $end) {
  $samples++
  foreach ($line in [CdSess]::Look()) {
    $p = $line.Split("|"); $peak = [double]$p[2]
    if ($peak -gt 0.001) {
      $exe = (Get-Process -Id ([int]$p[1]) -ErrorAction SilentlyContinue).ProcessName
      $key = "$($p[0]) | pid $($p[1]) | $exe"
      $heard[$key] = 1 + [int]$heard[$key]
    }
  }
  Start-Sleep -Milliseconds 250
}
$lines = @("samples=$samples")
foreach ($k in $heard.Keys) { $lines += "$k | heard in $($heard[$k]) samples" }
$lines | Out-File -Encoding utf8 $Out
$lines -join "`n"
