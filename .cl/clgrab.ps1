# clgrab.ps1 -AppPid <pid> -Out <png>: screenshot of the box around that process's visible top-level
# windows
# only (so the taskbar clock and other apps never enter a pixel compare). Win32 only, no UI
# Automation, so it never switches the app's accessibility tree on.
param([int]$AppPid, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public class ClWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static int[] Largest(uint want) {
    int[] best = null;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      RECT r;
      if (p == want && IsWindowVisible(h) && GetWindowRect(h, out r) && r.R > r.L && r.B > r.T) {
        if (best == null) { best = new int[] { r.L, r.T, r.R, r.B }; }
        else { best[0] = Math.Min(best[0], r.L); best[1] = Math.Min(best[1], r.T); best[2] = Math.Max(best[2], r.R); best[3] = Math.Max(best[3], r.B); }
      }
      return true;
    }, IntPtr.Zero);
    if (best != null) { best[2] -= best[0]; best[3] -= best[1]; }
    return best;
  }
}
"@
$r = [ClWin]::Largest([uint32]$AppPid)
if ($null -eq $r) { "no window"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $r[2], $r[3]
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r[0], $r[1], 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"window $($r[0]),$($r[1]),$($r[2]),$($r[3])"
