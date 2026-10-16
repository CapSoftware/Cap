# Prints what a Windows runner offers for D3D12 rendering: OS edition, the
# graphics DLLs, display devices, and the DXGI adapters with whether
# D3D12CreateDevice (feature level 11_0, what wgpu asks for) succeeds on each.
#
#   win-gpu-diag.ps1 [-Preload <dll>]...
#
# -Preload loads a DLL first (e.g. a NuGet d3d10warp.dll), the way a copy next
# to the test executable would be picked up by the D3D12 runtime.
param([string[]]$Preload = @())

$ErrorActionPreference = 'Continue'

$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Write-Host "os: $($cv.ProductName) | InstallationType=$($cv.InstallationType) | EditionID=$($cv.EditionID) | build $($cv.CurrentBuild).$($cv.UBR)"
$cs = Get-CimInstance Win32_ComputerSystem
Write-Host "machine: $($cs.Manufacturer) | $($cs.Model) | hypervisor=$($cs.HypervisorPresent)"

foreach ($dll in 'd3d12.dll', 'D3D12Core.dll', 'd3d10warp.dll', 'd3d11.dll', 'dxgi.dll', 'dxcore.dll', 'dcomp.dll', 'vulkan-1.dll', 'opengl32.dll') {
    $path = Join-Path $env:WINDIR "System32\$dll"
    if (Test-Path $path) {
        Write-Host "dll: $dll present ($((Get-Item $path).VersionInfo.FileVersion))"
    } else {
        Write-Host "dll: $dll MISSING"
    }
}

Write-Host 'pnp display/render devices:'
Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.Class -eq 'Display' -or $_.FriendlyName -match 'Render|Display|Video' } |
    ForEach-Object { Write-Host "  pnp: [$($_.Class)] $($_.FriendlyName) status=$($_.Status) id=$($_.InstanceId)" }
Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  videocontroller: $($_.Name) status=$($_.Status) driver=$($_.DriverVersion)" }
foreach ($svc in 'BasicRender', 'BasicDisplay') {
    $s = Get-CimInstance Win32_SystemDriver -Filter "Name='$svc'" -ErrorAction SilentlyContinue
    if ($s) { Write-Host "  driver: $svc state=$($s.State) start=$($s.StartMode)" } else { Write-Host "  driver: $svc not installed" }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CapDxDiag {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int CreateFactory1(ref Guid riid, out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int CreateDevice(IntPtr adapter, int minLevel, ref Guid riid, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int EnumAdapters1(IntPtr self, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int EnumWarp(IntPtr self, ref Guid riid, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDesc1(IntPtr self, out Desc1 desc);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Desc1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public uint LuidLow; public int LuidHigh; public uint Flags;
    }

    static T Slot<T>(IntPtr obj, int index) {
        IntPtr vtable = Marshal.ReadIntPtr(obj);
        return Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(vtable, index * IntPtr.Size));
    }

    public static string Load(string name) {
        IntPtr h = LoadLibraryW(name);
        return h == IntPtr.Zero ? "FAILED (error " + Marshal.GetLastWin32Error() + ")" : "ok";
    }

    static string TryDevice(CreateDevice create, IntPtr adapter) {
        Guid iidDevice = new Guid("189819f1-1db6-4b57-be54-1821339b85f7");
        IntPtr device;
        int hr = create(adapter, 0xb000, ref iidDevice, out device);
        if (hr >= 0 && device != IntPtr.Zero) Marshal.Release(device);
        return hr >= 0 ? "D3D12CreateDevice(11_0) ok" : string.Format("D3D12CreateDevice(11_0) FAILED hr=0x{0:X8}", hr);
    }

    static string Describe(IntPtr adapter) {
        Desc1 d;
        int hr = Slot<GetDesc1>(adapter, 10)(adapter, out d);
        if (hr < 0) return string.Format("GetDesc1 failed 0x{0:X8}", hr);
        return string.Format("'{0}' vendor=0x{1:X4} device=0x{2:X4} flags={3}{4}", d.Description, d.VendorId, d.DeviceId, d.Flags, (d.Flags & 2) != 0 ? " (SOFTWARE)" : "");
    }

    public static void Run() {
        IntPtr dxgi = LoadLibraryW("dxgi.dll");
        if (dxgi == IntPtr.Zero) { Console.WriteLine("dxgi: dxgi.dll failed to load, error " + Marshal.GetLastWin32Error()); return; }
        IntPtr d3d12 = LoadLibraryW("d3d12.dll");
        if (d3d12 == IntPtr.Zero) Console.WriteLine("d3d12: d3d12.dll failed to load, error " + Marshal.GetLastWin32Error());
        CreateDevice create = d3d12 == IntPtr.Zero ? null :
            Marshal.GetDelegateForFunctionPointer<CreateDevice>(GetProcAddress(d3d12, "D3D12CreateDevice"));

        CreateFactory1 createFactory = Marshal.GetDelegateForFunctionPointer<CreateFactory1>(GetProcAddress(dxgi, "CreateDXGIFactory1"));
        Guid iidFactory4 = new Guid("1bc6ea02-ef36-464f-bf0c-21ca39e5168a");
        IntPtr factory;
        int hr = createFactory(ref iidFactory4, out factory);
        if (hr < 0) { Console.WriteLine(string.Format("dxgi: CreateDXGIFactory1(IDXGIFactory4) failed 0x{0:X8}", hr)); return; }

        // What wgpu's DX12 backend sees: IDXGIFactory1::EnumAdapters1 (vtable 12).
        int count = 0;
        for (uint i = 0; ; i++) {
            IntPtr adapter;
            hr = Slot<EnumAdapters1>(factory, 12)(factory, i, out adapter);
            if (hr < 0) { if ((uint)hr != 0x887A0002) Console.WriteLine(string.Format("dxgi: EnumAdapters1({0}) failed 0x{1:X8}", i, hr)); break; }
            count++;
            Console.WriteLine("dxgi: adapter " + i + ": " + Describe(adapter) + (create != null ? " | " + TryDevice(create, adapter) : ""));
            Marshal.Release(adapter);
        }
        Console.WriteLine("dxgi: EnumAdapters1 returned " + count + " adapter(s)");

        // IDXGIFactory4::EnumWarpAdapter (vtable 27); wgpu 25 does not call it.
        Guid iidAdapter1 = new Guid("29038f61-3839-4626-91fd-086879011a05");
        IntPtr warp;
        hr = Slot<EnumWarp>(factory, 27)(factory, ref iidAdapter1, out warp);
        if (hr < 0) Console.WriteLine(string.Format("dxgi: EnumWarpAdapter failed 0x{0:X8}", hr));
        else {
            Console.WriteLine("dxgi: EnumWarpAdapter: " + Describe(warp) + (create != null ? " | " + TryDevice(create, warp) : ""));
            Marshal.Release(warp);
        }
        Marshal.Release(factory);
    }
}
'@

foreach ($dll in $Preload) {
    Write-Host "preload: $dll -> $([CapDxDiag]::Load($dll))"
}
[CapDxDiag]::Run()
