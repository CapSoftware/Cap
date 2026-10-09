import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { file, type Subprocess, spawn } from "bun";
import { registerSubprocess, terminateProcess } from "./subprocess";

const DEFAULT_CRF = 23;
const DEFAULT_KEYINT = 250;
const DEFAULT_NOISE = 3;
const CAPCODEC_PRESETS = new Set(["live", "fast", "medium", "slow"]);

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

export function mapCapcodecPreset(preset: string): string {
	const normalized = preset.trim().toLowerCase();
	if (
		normalized === "ultrafast" ||
		normalized === "superfast" ||
		normalized === "veryfast" ||
		normalized === "faster"
	) {
		return "fast";
	}
	if (
		normalized === "slower" ||
		normalized === "veryslow" ||
		normalized === "placebo"
	) {
		return "slow";
	}
	if (CAPCODEC_PRESETS.has(normalized)) return normalized;
	return "medium";
}

function parseCrf(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 51) return undefined;
	return value;
}

function parseBoundedInt(
	raw: string | undefined,
	min: number,
	max: number,
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) return undefined;
	return value;
}

function clampCrf(crf: number): number {
	if (!Number.isFinite(crf)) return DEFAULT_CRF;
	return Math.min(51, Math.max(0, crf));
}

export function capcodecOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
): CapcodecOptions | null {
	if (env.CAP_MEDIA_VIDEO_ENCODER !== "capcodec") return null;
	return {
		binary: env.CAPCODEC_BIN?.trim() || "capcodec",
		crf: parseCrf(env.CAPCODEC_CRF) ?? DEFAULT_CRF,
		preset: mapCapcodecPreset(env.CAPCODEC_PRESET ?? "medium"),
		keyint: parseBoundedInt(env.CAPCODEC_KEYINT, 1, 100_000) ?? DEFAULT_KEYINT,
		noise: parseBoundedInt(env.CAPCODEC_NOISE, 0, 255) ?? DEFAULT_NOISE,
	};
}

export function capcodecOptionsForJob(
	job: { crf: number; preset: string },
	env: Record<string, string | undefined> = process.env,
): CapcodecOptions | null {
	const base = capcodecOptionsFromEnv(env);
	if (!base) return null;
	const presetOverride = env.CAPCODEC_PRESET?.trim();
	return {
		...base,
		crf: parseCrf(env.CAPCODEC_CRF) ?? clampCrf(job.crf),
		preset: presetOverride
			? mapCapcodecPreset(presetOverride)
			: mapCapcodecPreset(job.preset),
	};
}

export async function assertCapcodecBinary(binary: string): Promise<void> {
	const resolved = binary.includes("/") ? binary : Bun.which(binary);
	if (resolved) {
		try {
			await access(resolved, constants.X_OK);
			return;
		} catch {}
	}
	throw new Error(
		`capcodec binary "${binary}" is not executable. The media-server image does not include capcodec. Mount a binary and set CAPCODEC_BIN to its path before setting CAP_MEDIA_VIDEO_ENCODER=capcodec. See /app/capcodec.md.`,
	);
}

export function remainingTimeoutMs(
	timeoutMs: number,
	elapsedMs: number,
): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 1;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return timeoutMs;
	return Math.max(1, timeoutMs - elapsedMs);
}

export function fitEvenSize(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	if (!(width > 0) || !(height > 0) || !(maxWidth > 0) || !(maxHeight > 0)) {
		throw new Error("Video dimensions must be positive");
	}
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
	if (!Number.isFinite(fps) || fps <= 0) return "30/1";
	const ntsc = [24, 30, 60].find(
		(base) => Math.abs(fps - (base * 1000) / 1001) < 0.01,
	);
	if (ntsc !== undefined) return `${ntsc * 1000}/1001`;
	const rounded = Math.round(fps * 1000);
	if (!Number.isFinite(rounded) || rounded <= 0) return "30/1";
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

function formatCrf(crf: number): string {
	if (Number.isInteger(crf)) return String(crf);
	return String(Math.round(crf * 1000) / 1000);
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
		formatCrf(options.crf),
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
	if (!match?.[1]) return null;
	return Number.parseInt(match[1], 10);
}

function pushStderrLine(lines: string[], line: string): void {
	lines.push(line);
	if (lines.length > 50) lines.shift();
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
				pushStderrLine(lines, line);
				onLine?.(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			pushStderrLine(lines, buffer);
			onLine?.(buffer);
		}
	} finally {
		reader.releaseLock();
	}
}

function cancelled(): Error {
	return new Error("Video processing was cancelled");
}

export async function encodeVideoWithCapcodec(
	job: CapcodecEncodeJob,
): Promise<void> {
	if (job.abortSignal?.aborted) throw cancelled();
	await assertCapcodecBinary(job.options.binary);
	const size = fitEvenSize(job.width, job.height, job.maxWidth, job.maxHeight);
	const fps = frameRateFraction(job.fps);
	let decoder: Subprocess | undefined;
	let encoder: Subprocess | undefined;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		if (!stopping) {
			const procs = [decoder, encoder].filter(
				(proc): proc is Subprocess => proc !== undefined,
			);
			stopping = Promise.all(procs.map((proc) => terminateProcess(proc))).then(
				() => undefined,
			);
		}
		return stopping;
	};
	const onAbort = () => {
		void stop();
	};
	try {
		decoder = registerSubprocess(
			spawn({
				cmd: buildCapcodecDecodeArgs(job, size.width, size.height, fps),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		encoder = registerSubprocess(
			spawn({
				cmd: buildCapcodecEncodeArgs(
					job.options,
					job.outputPath,
					size.width,
					size.height,
					fps,
				),
				stdin: decoder.stdout,
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
		job.abortSignal?.addEventListener("abort", onAbort, { once: true });
		const decoderLines: string[] = [];
		const encoderLines: string[] = [];
		await Promise.all([
			collectStderr(decoder.stderr, decoderLines, (line) => {
				const outTime = parseOutTimeUs(line);
				if (outTime !== null && job.onProgress && job.totalDurationUs > 0) {
					const progress = Math.min(100, (outTime / job.totalDurationUs) * 100);
					job.onProgress(progress, `Encoding: ${Math.round(progress)}%`);
				}
			}),
			collectStderr(encoder.stderr, encoderLines),
		]);
		if (job.abortSignal?.aborted) throw cancelled();
		const [decoderExit, encoderExit] = await Promise.all([
			decoder.exited,
			encoder.exited,
		]);
		if (job.abortSignal?.aborted) throw cancelled();
		if (decoderExit !== 0 || encoderExit !== 0) {
			const parts: string[] = [];
			if (decoderExit !== 0) {
				parts.push(
					`FFmpeg decode for capcodec exited with code ${decoderExit}. Last stderr: ${decoderLines.slice(-10).join(" | ")}`,
				);
			}
			if (encoderExit !== 0) {
				parts.push(
					`capcodec exited with code ${encoderExit}. Last stderr: ${encoderLines.slice(-10).join(" | ")}`,
				);
			}
			throw new Error(parts.join(" "));
		}
		if ((await file(job.outputPath).size) === 0) {
			throw new Error("capcodec produced an empty output file");
		}
	} catch (error) {
		if (job.abortSignal?.aborted) throw cancelled();
		throw error;
	} finally {
		job.abortSignal?.removeEventListener("abort", onAbort);
		await stop();
	}
}
