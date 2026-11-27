import { readFileSync } from "node:fs";

// /proc reports CPU time in USER_HZ ticks, which Linux fixes at 100 for user
// space on every architecture the farm runs on.
const PROC_TICKS_PER_SECOND = 100;
const PROC_UTIME_FIELD = 11;
const PROC_STIME_FIELD = 12;

interface IdleProcess {
	pid: number;
	exited: Promise<unknown>;
	resourceUsage?: () =>
		| { cpuTime: { user: number; system: number } }
		| undefined;
}

const live = new Map<number, number>();
let retiredMicros = 0;

export function parseProcStatCpuMicros(stat: string): number | null {
	const close = stat.lastIndexOf(")");
	if (close === -1) return null;
	const fields = stat.slice(close + 2).split(" ");
	const utime = Number(fields[PROC_UTIME_FIELD]);
	const stime = Number(fields[PROC_STIME_FIELD]);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return ((utime + stime) * 1_000_000) / PROC_TICKS_PER_SECOND;
}

export function readProcessCpuMicros(
	pid: number,
	procRoot = "/proc",
): number | null {
	try {
		return parseProcStatCpuMicros(
			readFileSync(`${procRoot}/${pid}/stat`, "utf8"),
		);
	} catch {
		return null;
	}
}

// A process that has exited is counted from its final resource usage, so the
// CPU it used between the last reading and its exit is not lost. Bun types the
// CPU times as numbers but returns BigInts.
export function trackIdleProcess(proc: IdleProcess): void {
	live.set(proc.pid, 0);
	const retire = () => {
		const seen = live.get(proc.pid) ?? 0;
		live.delete(proc.pid);
		let used = 0;
		try {
			const cpu = proc.resourceUsage?.()?.cpuTime;
			if (cpu) used = Number(cpu.user) + Number(cpu.system);
		} catch {}
		retiredMicros += Number.isFinite(used) ? Math.max(seen, used) : seen;
	};
	proc.exited.then(retire, retire);
}

// Total CPU time, in microseconds, used by idle processes so far. Without
// /proc (macOS in development) a running process reads as the CPU it had used
// when last read, so only finished processes count.
export function idleProcessCpuMicros(
	read: (pid: number) => number | null = readProcessCpuMicros,
): number {
	let total = retiredMicros;
	for (const [pid, seen] of live) {
		const now = read(pid);
		const value = now === null ? seen : Math.max(seen, now);
		live.set(pid, value);
		total += value;
	}
	return total;
}

export function getLiveIdleProcessCount(): number {
	return live.size;
}
