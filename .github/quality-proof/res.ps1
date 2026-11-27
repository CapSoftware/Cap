param([int]$Width = 1920, [int]$Height = 1080, [int]$Hz = 0, [string]$Device = "")
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Res {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DISPLAY_DEVICE d, int f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr p);
  static DEVMODE Blank() { var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return dm; }
  public static string List() {
    var sb = new StringBuilder();
    for (int i = 0; ; i++) {
      var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      var dm = Blank();
      bool cur = EnumDisplaySettings(d.DeviceName, -1, ref dm);
      sb.AppendFormat("{0} '{1}' flags=0x{2:x} active={3} {4}x{5}@{6} pos={7},{8}\n", d.DeviceName, d.DeviceString, d.StateFlags, cur, dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency, dm.dmPositionX, dm.dmPositionY);
      var seen = new System.Collections.Generic.HashSet<string>();
      for (int j = 0; ; j++) {
        var m = Blank();
        if (!EnumDisplaySettings(d.DeviceName, j, ref m)) break;
        if (m.dmDisplayFrequency > 60) { var k = m.dmPelsWidth + "x" + m.dmPelsHeight + "@" + m.dmDisplayFrequency; if (seen.Add(k)) sb.Append("    mode " + k + "\n"); }
      }
    }
    return sb.ToString();
  }
  public static string Set(string dev, int w, int h, int hz) {
    var dm = Blank();
    EnumDisplaySettings(dev, -1, ref dm);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    if (hz > 0) { dm.dmDisplayFrequency = hz; dm.dmFields |= 0x400000; }
    int rc = ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 1, IntPtr.Zero);
    var now = Blank();
    EnumDisplaySettings(dev, -1, ref now);
    return String.Format("set {0} {1}x{2}@{3} rc={4} now {5}x{6}@{7}", dev, w, h, hz, rc, now.dmPelsWidth, now.dmPelsHeight, now.dmDisplayFrequency);
  }
}
"@
[Res]::List()
if ($Device) { [Res]::Set($Device, $Width, $Height, $Hz) } else { [Res]::Set($null, $Width, $Height, $Hz) }
[Res]::List()
