import { spawn } from "bun";
import {
	PROCESS_TIMEOUT_MS,
	withIdleTimeout,
	withTimeout,
} from "./media-common";
import { registerSubprocess, terminateProcess } from "./subprocess";

const MAX_DIAGNOSTIC_LENGTH = 8_192;

export interface ValidationProgress {
	idleTimeoutMs: number;
	onProgress: () => void;
}

export async function validateVideoInput(
	inputPath: string,
	abortSignal?: AbortSignal,
	timeoutMs = PROCESS_TIMEOUT_MS,
	progress?: ValidationProgress,
): Promise<void> {
	abortSignal?.throwIfAborted();
	const proc = registerSubprocess(
		spawn({
			cmd: [
				"ffmpeg",
				"-hide_banner",
				"-nostdin",
				"-v",
				"error",
				"-xerror",
				"-err_detect",
				"explode+crccheck",
				"-threads",
				"2",
				"-i",
				inputPath,
				"-map",
				"0:v:0",
				"-map",
				"0:a?",
				"-fps_mode",
				"passthrough",
				"-enc_time_base:v",
				"demux",
				"-abort_on",
				"empty_output",
				...(progress ? ["-progress", "pipe:1"] : []),
				"-f",
				"null",
				"-",
			],
			stdout: progress ? "pipe" : "ignore",
			stderr: "pipe",
		}),
	);
	const abort = () => {
		void terminateProcess(proc);
	};
	abortSignal?.addEventListener("abort", abort, { once: true });
	if (abortSignal?.aborted) abort();
	const readDiagnostics = async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		let diagnostics = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				diagnostics = (
					diagnostics + decoder.decode(value, { stream: true })
				).slice(-MAX_DIAGNOSTIC_LENGTH);
			}
			return (diagnostics + decoder.decode()).trim();
		} finally {
			reader.releaseLock();
		}
	};
	const readProgress = async (touch: () => void) => {
		if (!progress) return;
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		let decodedUs = -1;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					const match = line.match(/^out_time_us=(\d+)/);
					const outTimeUs = match ? Number.parseInt(match[1] ?? "0", 10) : -1;
					if (outTimeUs <= decodedUs) continue;
					decodedUs = outTimeUs;
					touch();
					progress.onProgress();
				}
			}
		} finally {
			reader.releaseLock();
		}
	};
	let completion: Promise<unknown> = Promise.resolve();
	const run = (touch: () => void) => {
		const settled = Promise.all([
			proc.exited,
			readDiagnostics(),
			readProgress(touch),
		]);
		completion = settled;
		return settled;
	};
	try {
		const [exitCode, diagnostics] = progress
			? await withIdleTimeout(run, progress.idleTimeoutMs, () =>
					terminateProcess(proc),
				)
			: await withTimeout(
					run(() => {}),
					timeoutMs,
					() => terminateProcess(proc),
				);
		abortSignal?.throwIfAborted();
		if (diagnostics) {
			console.warn("[video/input-validation] Source decoding diagnostics", {
				exitCode,
				diagnostics: diagnostics.replaceAll(inputPath, "<recording input>"),
			});
		}
		if (exitCode !== 0) {
			throw new Error(
				"The recording contains damaged or unreadable media. The original upload has been preserved for recovery.",
			);
		}
	} finally {
		abortSignal?.removeEventListener("abort", abort);
		await terminateProcess(proc);
		await completion.catch(() => {});
	}
}
