import { file, spawn } from "bun";
import { registerSubprocess, terminateProcess } from "./subprocess";

export interface CapcodecOptions {
	binary: string;
	crf: number;
	preset: string;
	keyint: number;
	noise: number;
}

export interface CapcodecEncodeJob {
	inputPath: string;
	outputPath: string;
	width: number;
	height: number;
	fps: number;
	maxWidth: number;
	maxHeight: number;
	extraInputArgs: string[];
	options: CapcodecOptions;
	totalDurationUs: number;
	onProgress?: (progress: number, message: string) => void;
	abortSignal?: AbortSignal;
}

export function capcodecOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
): CapcodecOptions | null {
	if (env.CAP_MEDIA_VIDEO_ENCODER !== "capcodec") {
		return null;
	}
	const crf = Number(env.CAPCODEC_CRF ?? "23");
	const keyint = Number(env.CAPCODEC_KEYINT ?? "250");
	const noise = Number(env.CAPCODEC_NOISE ?? "3");
	return {
		binary: env.CAPCODEC_BIN ?? "capcodec",
		crf: Number.isFinite(crf) ? crf : 23,
		preset: env.CAPCODEC_PRESET ?? "medium",
		keyint: Number.isInteger(keyint) && keyint > 0 ? keyint : 250,
		noise: Number.isInteger(noise) && noise >= 0 ? noise : 3,
	};
}

export function fitEvenSize(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const boxWidth = Math.min(maxWidth, width);
	const boxHeight = Math.min(maxHeight, height);
	const scale = Math.min(boxWidth / width, boxHeight / height);
	const scaledWidth = Math.round(width * scale);
	const scaledHeight = Math.round(height * scale);
	return {
		width: Math.max(2, Math.trunc(scaledWidth / 2) * 2),
		height: Math.max(2, Math.trunc(scaledHeight / 2) * 2),
	};
}

export function frameRateFraction(fps: number): string {
	if (!Number.isFinite(fps) || fps <= 0) {
		return "30/1";
	}
	const ntsc = [24, 30, 60].find(
		(base) => Math.abs(fps - (base * 1000) / 1001) < 0.01,
	);
	if (ntsc !== undefined) {
		return `${ntsc * 1000}/1001`;
	}
	const rounded = Math.round(fps * 1000);
	const divisor = gcd(rounded, 1000);
	return `${rounded / divisor}/${1000 / divisor}`;
}

function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}

export function buildCapcodecDecodeArgs(
	job: Pick<CapcodecEncodeJob, "inputPath" | "extraInputArgs">,
	width: number,
	height: number,
	fps: string,
): string[] {
	return [
		"ffmpeg",
		"-hide_banner",
		"-nostdin",
		"-threads",
		"2",
		...job.extraInputArgs,
		"-i",
		job.inputPath,
		"-map",
		"0:v:0",
		"-vf",
		`scale=${width}:${height}:flags=bicubic,format=yuv420p`,
		"-fps_mode",
		"cfr",
		"-r",
		fps,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"yuv420p",
		"-progress",
		"pipe:2",
		"-",
	];
}

export function buildCapcodecEncodeArgs(
	options: CapcodecOptions,
	outputPath: string,
	width: number,
	height: number,
	fps: string,
): string[] {
	return [
		options.binary,
		"encode",
		"--input",
		"-",
		"--width",
		String(width),
		"--height",
		String(height),
		"--fps",
		fps,
		"--crf",
		String(options.crf),
		"--preset",
		options.preset,
		"--keyint",
		String(options.keyint),
		"--noise",
		String(options.noise),
		"--output",
		outputPath,
	];
}

function parseOutTimeUs(line: string): number | null {
	const match = line.match(/^out_time_us=(\d+)/);
	if (!match?.[1]) {
		return null;
	}
	return Number.parseInt(match[1], 10);
}

async function collectStderr(
	stream: ReadableStream<Uint8Array>,
	lines: string[],
	onLine?: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const line of parts) {
				lines.push(line);
				if (lines.length > 50) {
					lines.shift();
				}
				onLine?.(line);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export async function encodeVideoWithCapcodec(
	job: CapcodecEncodeJob,
): Promise<void> {
	const size = fitEvenSize(job.width, job.height, job.maxWidth, job.maxHeight);
	const fps = frameRateFraction(job.fps);
	const decoder = registerSubprocess(
		spawn({
			cmd: buildCapcodecDecodeArgs(job, size.width, size.height, fps),
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const encoder = registerSubprocess(
		spawn({
			cmd: buildCapcodecEncodeArgs(
				job.options,
				job.outputPath,
				size.width,
				size.height,
				fps,
			),
			stdin: decoder.stdout as ReadableStream<Uint8Array>,
			stdout: "ignore",
			stderr: "pipe",
		}),
	);
	const abort = () => {
		void terminateProcess(decoder);
		void terminateProcess(encoder);
	};
	job.abortSignal?.addEventListener("abort", abort, { once: true });
	const decoderLines: string[] = [];
	const encoderLines: string[] = [];
	try {
		await Promise.all([
			collectStderr(
				decoder.stderr as ReadableStream<Uint8Array>,
				decoderLines,
				(line) => {
					const outTime = parseOutTimeUs(line);
					if (outTime !== null && job.onProgress && job.totalDurationUs > 0) {
						const progress = Math.min(
							100,
							(outTime / job.totalDurationUs) * 100,
						);
						job.onProgress(progress, `Encoding: ${Math.round(progress)}%`);
					}
				},
			),
			collectStderr(encoder.stderr as ReadableStream<Uint8Array>, encoderLines),
		]);
		const [decoderExit, encoderExit] = await Promise.all([
			decoder.exited,
			encoder.exited,
		]);
		if (decoderExit !== 0) {
			throw new Error(
				`FFmpeg decode for capcodec exited with code ${decoderExit}. Last stderr: ${decoderLines.slice(-10).join(" | ")}`,
			);
		}
		if (encoderExit !== 0) {
			throw new Error(
				`capcodec exited with code ${encoderExit}. Last stderr: ${encoderLines.slice(-10).join(" | ")}`,
			);
		}
		if ((await file(job.outputPath).size) === 0) {
			throw new Error("capcodec produced an empty output file");
		}
	} finally {
		job.abortSignal?.removeEventListener("abort", abort);
		await terminateProcess(decoder);
		await terminateProcess(encoder);
	}
}
