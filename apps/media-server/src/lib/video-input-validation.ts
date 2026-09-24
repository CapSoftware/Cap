import { spawn } from "bun";
import { PROCESS_TIMEOUT_MS, withTimeout } from "./media-common";
import { registerSubprocess, terminateProcess } from "./subprocess";

const MAX_DIAGNOSTIC_LENGTH = 8_192;

export async function validateVideoInput(
	inputPath: string,
	abortSignal?: AbortSignal,
	timeoutMs = PROCESS_TIMEOUT_MS,
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
				"-f",
				"null",
				"-",
			],
			stdout: "ignore",
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
	const completion = Promise.all([proc.exited, readDiagnostics()]);
	try {
		const [exitCode, diagnostics] = await withTimeout(
			completion,
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
