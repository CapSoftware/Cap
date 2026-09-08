import type { Subprocess } from "bun";

const PROCESS_EXIT_WAIT_MS = 5_000;
const FORCE_KILL_WAIT_MS = 1_000;

type ManagedSubprocess = Pick<
	Subprocess,
	"pid" | "exited" | "exitCode" | "kill"
>;

const activeSubprocesses = new Map<number, ManagedSubprocess>();

export function registerSubprocess<T extends ManagedSubprocess>(proc: T): T {
	activeSubprocesses.set(proc.pid, proc);
	return proc;
}

export function unregisterSubprocess(proc: ManagedSubprocess): void {
	activeSubprocesses.delete(proc.pid);
}

async function waitForProcessExit(
	proc: Pick<Subprocess, "exited" | "exitCode">,
	timeoutMs: number,
): Promise<boolean> {
	if (proc.exitCode !== null) {
		return true;
	}

	const result = await Promise.race([
		proc.exited.then(
			() => true,
			() => true,
		),
		new Promise<false>((resolve) => {
			setTimeout(() => resolve(false), timeoutMs);
		}),
	]);

	return result;
}

export async function terminateProcess(
	proc: ManagedSubprocess,
	timeoutMs = PROCESS_EXIT_WAIT_MS,
): Promise<void> {
	if (proc.exitCode !== null) {
		unregisterSubprocess(proc);
		return;
	}

	try {
		proc.kill("SIGTERM");
	} catch {}

	const exited = await waitForProcessExit(proc, timeoutMs);

	if (!exited && proc.exitCode === null) {
		try {
			proc.kill("SIGKILL");
		} catch {}

		await waitForProcessExit(proc, FORCE_KILL_WAIT_MS);
	}

	unregisterSubprocess(proc);
}

export async function terminateAllSubprocesses(): Promise<void> {
	const processes = Array.from(activeSubprocesses.values());
	await Promise.allSettled(processes.map((proc) => terminateProcess(proc)));
}
