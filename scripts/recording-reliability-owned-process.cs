using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class CapOwnedProcess : IDisposable
{
    private const uint KillOnJobClose = 0x2000;
    private const uint CreateSuspended = 4;
    private IntPtr job;
    private IntPtr process;
    public int Id { get; private set; }

    public static CapOwnedProcess Start(string binary, string arguments, string directory, string stdout, string stderr)
    {
        var owned = new CapOwnedProcess();
        IntPtr output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero, thread = IntPtr.Zero;
        try
        {
            owned.job = CreateJobObjectW(IntPtr.Zero, null);
            if (owned.job == IntPtr.Zero) Fail("CreateJobObject");
            var limits = new ExtendedLimit();
            limits.Basic.Flags = KillOnJobClose;
            if (!SetInformationJobObject(owned.job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) Fail("SetInformationJobObject");
            var security = new SecurityAttributes();
            security.Length = (uint)Marshal.SizeOf(typeof(SecurityAttributes));
            security.Inherit = true;
            output = CreateFileW(stdout, 0x40000000, 3, ref security, 1, 0x80, IntPtr.Zero);
            CheckFile(output, "Create stdout");
            error = CreateFileW(stderr, 0x40000000, 3, ref security, 1, 0x80, IntPtr.Zero);
            CheckFile(error, "Create stderr");
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            CheckFile(input, "Open NUL");
            var startup = new StartupInfo();
            startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.Flags = 0x100;
            startup.Input = input;
            startup.Output = output;
            startup.Error = error;
            ProcessInformation info;
            var command = new StringBuilder("\"" + binary + "\" " + arguments);
            if (!CreateProcessW(binary, command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended, IntPtr.Zero, directory, ref startup, out info)) Fail("CreateProcess suspended");
            owned.process = info.Process;
            thread = info.Thread;
            owned.Id = checked((int)info.ProcessId);
            if (!AssignProcessToJobObject(owned.job, owned.process)) Fail("AssignProcessToJobObject");
            if (ResumeThread(thread) == UInt32.MaxValue) Fail("ResumeThread");
            return owned;
        }
        catch
        {
            if (owned.process != IntPtr.Zero)
            {
                TerminateProcess(owned.process, 1);
                WaitForSingleObject(owned.process, 5000);
            }
            owned.Dispose();
            throw;
        }
        finally
        {
            Close(thread);
            Close(input);
            Close(error);
            Close(output);
        }
    }

    public bool WaitForExit(int milliseconds)
    {
        if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
        uint result = WaitForSingleObject(process, (uint)milliseconds);
        if (result == 0) return true;
        if (result == 258) return false;
        Fail("WaitForSingleObject");
        return false;
    }

    public int ExitCode
    {
        get
        {
            uint code;
            if (!GetExitCodeProcess(process, out code)) Fail("GetExitCodeProcess");
            return unchecked((int)code);
        }
    }

    public int ActiveProcesses
    {
        get
        {
            BasicAccounting accounting;
            uint returned;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(BasicAccounting)), out returned)) Fail("QueryInformationJobObject");
            return checked((int)accounting.ActiveProcesses);
        }
    }

    public DateTime StartedUtc { get { return Time(false); } }
    public DateTime ExitedUtc { get { return Time(true); } }

    private DateTime Time(bool exit)
    {
        long creation, ended, kernel, user;
        if (!GetProcessTimes(process, out creation, out ended, out kernel, out user)) Fail("GetProcessTimes");
        return DateTime.FromFileTimeUtc(exit ? ended : creation);
    }

    public sealed class OwnedIdentity
    {
        public int ProcessId { get; set; }
        public bool MembershipVerified { get; set; }
        public string ExecutablePath { get; set; }
        public string StartedUtc { get; set; }
        public long KernelTimeTicks { get; set; }
        public long UserTimeTicks { get; set; }
        public string InspectionError { get; set; }
    }

    public OwnedIdentity[] SnapshotOwnedProcesses()
    {
        for (int attempt = 0; attempt < 8; attempt++)
        {
            int capacity = 32 << attempt;
            int bytes = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(bytes);
            try
            {
                uint returned;
                if (!QueryInformationJobObject(job, 3, buffer, (uint)bytes, out returned))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 234) continue;
                    throw new Win32Exception(error, "Query owned process identifiers");
                }
                int assigned = Marshal.ReadInt32(buffer, 0);
                int count = Marshal.ReadInt32(buffer, 4);
                if (count < 0 || count > capacity || count > assigned) throw new InvalidOperationException("Invalid owned process list");
                if (count < assigned) continue;
                var identities = new List<OwnedIdentity>();
                for (int index = 0; index < count; index++)
                {
                    int pid = checked((int)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
                    var identity = new OwnedIdentity { ProcessId = pid };
                    IntPtr child = OpenProcess(0x1000, false, (uint)pid);
                    try
                    {
                        if (child == IntPtr.Zero) Fail("Open owned process for identity");
                        bool member;
                        if (!IsProcessInJob(child, job, out member)) Fail("Verify owned process membership");
                        if (!member) throw new InvalidOperationException("Process exited or no longer belongs to the owned job");
                        identity.MembershipVerified = true;
                        long creation, ended, kernel, user;
                        if (!GetProcessTimes(child, out creation, out ended, out kernel, out user)) Fail("Get owned process times");
                        identity.StartedUtc = DateTime.FromFileTimeUtc(creation).ToString("o");
                        identity.KernelTimeTicks = kernel;
                        identity.UserTimeTicks = user;
                        var path = new StringBuilder(32768);
                        uint length = (uint)path.Capacity;
                        if (!QueryFullProcessImageNameW(child, 0, path, ref length)) Fail("Get owned process image");
                        identity.ExecutablePath = path.ToString();
                    }
                    catch (Exception error)
                    {
                        identity.InspectionError = error.Message;
                    }
                    finally { Close(child); }
                    identities.Add(identity);
                }
                return identities.ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new InvalidOperationException("Owned process list did not stabilize within bounded queries");
    }

    public void TerminateOwnedTree()
    {
        if (!TerminateJobObject(job, 1)) Fail("TerminateJobObject");
    }

    public bool WaitForEmpty(int milliseconds)
    {
        if (milliseconds < 0) throw new ArgumentOutOfRangeException("milliseconds");
        var clock = Stopwatch.StartNew();
        do
        {
            if (ActiveProcesses == 0) return true;
            Thread.Sleep(10);
        } while (clock.ElapsedMilliseconds < milliseconds);
        return ActiveProcesses == 0;
    }

    public void Dispose()
    {
        Close(job);
        job = IntPtr.Zero;
        Close(process);
        process = IntPtr.Zero;
    }

    private static void Fail(string operation) { throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    private static void CheckFile(IntPtr handle, string operation) { if (handle == IntPtr.Zero || handle == new IntPtr(-1)) Fail(operation); }
    private static void Close(IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public uint Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        public uint TotalPageFaults, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out BasicAccounting accounting, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr information, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation information);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
