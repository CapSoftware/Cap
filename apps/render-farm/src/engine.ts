import { type Subprocess, spawn } from "bun";

// A warm `cap-render-farm` process. One per render slot: requests are
// serialized per process, and the process stays alive between tasks so its
// GPU device, compiled layer pipelines and ffmpeg state are reused.

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export class Engine {
	private process: Subprocess<"pipe", "pipe", "pipe">;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = "";
	private exited = false;
	readonly stderrTail: string[] = [];
	/** Latest progress value per in-flight request (frames rendered). */
	onProgress: ((value: number) => void) | null = null;
	/** Streaming events for the request in flight (`gop`, `extradata`). */
	onEvent: ((event: Record<string, unknown>) => void) | null = null;

	constructor(
		readonly binary: string,
		readonly env: Record<string, string> = {},
		readonly label = "engine",
		/** Scheduling niceness: background lanes yield the CPU to render slots. */
		readonly nice = 0,
	) {
		this.process = spawn(
			nice > 0 ? ["nice", "-n", String(nice), binary] : [binary],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...env },
			},
		);
		this.pump();
		this.pumpErrors();
		this.process.exited.then((code) => {
			this.exited = true;
			const error = new Error(
				`${label} exited with ${code}: ${this.stderrTail.slice(-5).join(" | ")}`,
			);
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		});
	}

	get pid() {
		return this.process.pid;
	}

	get alive() {
		return !this.exited;
	}

	private async pump() {
		const decoder = new TextDecoder();
		for await (const chunk of this.process.stdout) {
			this.buffer += decoder.decode(chunk, { stream: true });
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				if (!line.trim()) continue;
				let message: {
					id?: number;
					ok: boolean;
					result?: unknown;
					error?: string;
					progress?: number;
				};
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.progress !== undefined) {
					this.onProgress?.(message.progress);
					continue;
				}
				if (message.ok === undefined && message.error === undefined) {
					this.onEvent?.(message as Record<string, unknown>);
					continue;
				}
				const pending =
					message.id === undefined ? undefined : this.pending.get(message.id);
				if (!pending || message.id === undefined) continue;
				this.pending.delete(message.id);
				if (message.ok) pending.resolve(message.result);
				else pending.reject(new Error(message.error ?? "engine error"));
			}
		}
	}

	private async pumpErrors() {
		const decoder = new TextDecoder();
		let partial = "";
		for await (const chunk of this.process.stderr) {
			partial += decoder.decode(chunk, { stream: true });
			const lines = partial.split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim() || line.startsWith("[libx264")) continue;
				this.stderrTail.push(line.slice(0, 400));
				if (this.stderrTail.length > 50) this.stderrTail.shift();
				if (process.env.RF_ENGINE_LOG === "1")
					console.error(`[${this.label}] ${line}`);
			}
		}
	}

	request<T>(op: string, body: Record<string, unknown>): Promise<T> {
		if (this.exited)
			return Promise.reject(new Error(`${this.label} is not running`));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.process.stdin.write(`${JSON.stringify({ id, op, ...body })}\n`);
			this.process.stdin.flush();
		});
	}

	kill(signal?: NodeJS.Signals) {
		this.process.kill(signal);
	}
}

/** CPU seconds a process (and its threads) has used, from /proc. */
export async function processCpuSeconds(pid: number) {
	try {
		const stat = await Bun.file(`/proc/${pid}/stat`).text();
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[11]) + Number(fields[12]);
		return ticks / 100;
	} catch {
		return 0;
	}
}

/** CPU seconds per thread name, for profiling (RF_PROFILE_THREADS=1). */
export async function threadCpu(pid: number) {
	const out: Record<string, number> = {};
	try {
		const { readdirSync } = await import("node:fs");
		for (const tid of readdirSync(`/proc/${pid}/task`)) {
			try {
				const stat = await Bun.file(`/proc/${pid}/task/${tid}/stat`).text();
				const name = stat
					.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
					.replace(/[-_:]?\d+$/, "");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				out[name] =
					(out[name] ?? 0) + (Number(fields[11]) + Number(fields[12])) / 100;
			} catch {}
		}
	} catch {}
	return out;
}

export function diffThreads(
	before: Record<string, number>,
	after: Record<string, number>,
) {
	const out: Record<string, number> = {};
	for (const [name, value] of Object.entries(after)) {
		const delta = value - (before[name] ?? 0);
		if (delta > 0.05) out[name] = Math.round(delta * 10) / 10;
	}
	return out;
}

/**
 * Samples every thread of `pid` until `until` settles; returns CPU seconds by
 * thread name. Render threads exit with the task, so a before/after diff
 * would miss them.
 */
export async function sampleThreads(pid: number, until: Promise<unknown>) {
	const { readdirSync } = await import("node:fs");
	const seen = new Map<string, { name: string; first: number; last: number }>();
	let done = false;
	const stop = () => {
		done = true;
	};
	until.then(stop, stop);
	while (!done) {
		try {
			for (const tid of readdirSync(`/proc/${pid}/task`)) {
				try {
					const stat = await Bun.file(`/proc/${pid}/task/${tid}/stat`).text();
					const name = stat
						.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
						.replace(/[-_:. ]?\d+$/, "");
					const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
					const cpu = (Number(fields[11]) + Number(fields[12])) / 100;
					const entry = seen.get(tid);
					if (entry) entry.last = cpu;
					else seen.set(tid, { name, first: cpu, last: cpu });
				} catch {}
			}
		} catch {}
		await Bun.sleep(500);
	}
	const out: Record<string, number> = {};
	for (const entry of seen.values()) {
		out[entry.name] =
			Math.round(((out[entry.name] ?? 0) + entry.last - entry.first) * 10) / 10;
	}
	return out;
}
