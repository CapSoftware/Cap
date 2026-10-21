"""ru.py <pid> <seconds>: per-process resource deltas via proc_pid_rusage(RUSAGE_INFO_V4).
Prints CPU %, interrupt wakeups/s, package-idle wakeups/s, instructions/s (M), phys_footprint MB, lifetime max footprint MB."""
import ctypes, sys, time
U64 = ctypes.c_uint64
class RU4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, U64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size", "resident_size",
        "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time", "child_system_time",
        "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins", "child_elapsed_abstime",
        "diskio_bytesread", "diskio_byteswritten", "qos_default", "qos_maintenance", "qos_background",
        "qos_utility", "qos_legacy", "qos_user_initiated", "qos_user_interactive", "billed_system_time",
        "serviced_system_time", "logical_writes", "lifetime_max_phys_footprint", "instructions", "cycles",
        "billed_energy", "serviced_energy", "interval_max_phys_footprint", "runnable_time")]
libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
class TB(ctypes.Structure): _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
tb = TB(); ctypes.CDLL("/usr/lib/libSystem.dylib").mach_timebase_info(ctypes.byref(tb))
def snap(pid):
    r = RU4()
    if libproc.proc_pid_rusage(pid, 4, ctypes.byref(r)) != 0: raise SystemExit(f"proc_pid_rusage failed for {pid}")
    return r, time.monotonic()
pid, secs = int(sys.argv[1]), float(sys.argv[2])
a, t0 = snap(pid); time.sleep(secs); b, t1 = snap(pid)
dt = t1 - t0
cpu_ns = ((b.user_time + b.system_time) - (a.user_time + a.system_time)) * tb.numer / tb.denom
print(f"cpu%={100*cpu_ns/1e9/dt:.2f} wakeups/s={(b.interrupt_wkups-a.interrupt_wkups)/dt:.0f} "
      f"idle_wakeups/s={(b.pkg_idle_wkups-a.pkg_idle_wkups)/dt:.0f} Minstr/s={(b.instructions-a.instructions)/dt/1e6:.1f} "
      f"footprint={b.phys_footprint/1048576:.0f}MB max={b.lifetime_max_phys_footprint/1048576:.0f}MB")
