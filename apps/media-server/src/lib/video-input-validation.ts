import { spawn } from "bun";
import {
	decodeThreadsFromEnv,
	PROCESS_TIMEOUT_MS,
	withTimeout,
} from "./media-common";
import { registerSubprocess, terminateProcess } from "./subprocess";

const MAX_DIAGNOSTIC_LENGTH = 8_192;

export const DAMAGED_INPUT_MESSAGE =
	"The recording contains damaged or unreadable media. The original upload has been preserved for recovery.";
export const NO_VIDEO_INPUT_MESSAGE =
	"The recording has no video. Nothing was captured before it stopped. The original upload has been preserved.";

export type VideoInputCondition = "clean" | "damaged";

function hasNoVideoStream(diagnostics: string) {
	return (
		diagnostics.includes("matches no streams") && diagnostics.includes("0:v:0")
	);
}

function couldNotOpenInput(diagnostics: string) {
	return diagnostics.includes("Error opening input");
}

export async function validateVideoInput(
	inputPath: string,
	abortSignal?: AbortSignal,
	timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<VideoInputCondition> {
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
				decodeThreadsFromEnv("MEDIA_SERVER_VALIDATE_DECODE_THREADS", 2),
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
		if (exitCode === 0) return "clean";
		if (hasNoVideoStream(diagnostics)) throw new Error(NO_VIDEO_INPUT_MESSAGE);
		if (couldNotOpenInput(diagnostics)) throw new Error(DAMAGED_INPUT_MESSAGE);
		// Strict decoding stops at the first bad packet, so one damaged frame used to fail
		// an hour-long recording. The caller recovers what decodes and only rejects the
		// source when the recovered output falls short of the recording's duration.
		return "damaged";
	} finally {
		abortSignal?.removeEventListener("abort", abort);
		await terminateProcess(proc);
		await completion.catch(() => {});
	}
}
