import { type Subprocess, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";

const PROBE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

let activeProbeProcesses = 0;
const MAX_CONCURRENT_PROBE_PROCESSES = 6;

export function getActiveProbeProcessCount(): number {
	return activeProbeProcesses;
}

export function canAcceptNewProbeProcess(): boolean {
	return activeProbeProcesses < MAX_CONCURRENT_PROBE_PROCESSES;
}

function killProcess(proc: Subprocess): void {
	try {
		proc.kill();
	} catch {}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	cleanup?: () => void,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			cleanup?.();
			reject(new Error(`Operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([promise, timeoutPromise]);
		if (timeoutId) clearTimeout(timeoutId);
		return result;
	} catch (err) {
		if (timeoutId) clearTimeout(timeoutId);
		throw err;
	}
}

async function readStreamToString(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (totalBytes < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalBytes += value.length;
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	return chunks
		.map((chunk) => decoder.decode(chunk, { stream: true }))
		.join("");
}

interface FFprobeOutput {
	format?: {
		duration?: string;
		size?: string;
		bit_rate?: string;
	};
	streams?: Array<{
		codec_type?: "video" | "audio";
		codec_name?: string;
		width?: number;
		height?: number;
		r_frame_rate?: string;
		avg_frame_rate?: string;
		channels?: number;
		sample_rate?: string;
	}>;
}

function parseFrameRate(rateStr: string | undefined): number {
	if (!rateStr) return 0;
	const parts = rateStr.split("/");
	if (parts.length === 2) {
		const num = Number.parseFloat(parts[0] ?? "0");
		const den = Number.parseFloat(parts[1] ?? "1");
		if (den !== 0) return num / den;
	}
	return Number.parseFloat(rateStr) || 0;
}

export async function probeVideo(videoUrl: string): Promise<VideoMetadata> {
	if (!canAcceptNewProbeProcess()) {
		throw new Error("Server is busy, please try again later");
	}

	activeProbeProcesses++;

	const proc = spawn({
		cmd: [
			"ffprobe",
			"-v",
			"quiet",
			"-print_format",
			"json",
			"-show_format",
			"-show_streams",
			videoUrl,
		],
		stdout: "pipe",
		stderr: "pipe",
	});

	try {
		const result = await withTimeout(
			(async () => {
				const stdoutText = await readStreamToString(
					proc.stdout as ReadableStream<Uint8Array>,
					MAX_OUTPUT_BYTES,
				);

				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					throw new Error(`ffprobe exited with code ${exitCode}`);
				}

				const data: FFprobeOutput = JSON.parse(stdoutText);

				console.log(
					`[probeVideo] ffprobe output for ${videoUrl.substring(0, 80)}...: format=${JSON.stringify(data.format)}, streams=${data.streams?.length ?? 0}`,
				);
				if (data.streams) {
					for (const stream of data.streams) {
						console.log(
							`[probeVideo] Stream: codec_type=${stream.codec_type}, codec_name=${stream.codec_name}, width=${stream.width}, height=${stream.height}`,
						);
					}
				}

				const videoStream = data.streams?.find((s) => s.codec_type === "video");
				const audioStream = data.streams?.find((s) => s.codec_type === "audio");

				if (!videoStream) {
					console.error(
						`[probeVideo] No video stream found in file. Raw output: ${stdoutText.substring(0, 500)}`,
					);
					throw new Error("No video stream found");
				}

				const duration = Number.parseFloat(data.format?.duration ?? "0");
				const fileSize = Number.parseInt(data.format?.size ?? "0", 10);
				const bitrate = Number.parseInt(data.format?.bit_rate ?? "0", 10);
				const fps =
					parseFrameRate(videoStream.r_frame_rate) ||
					parseFrameRate(videoStream.avg_frame_rate);

				return {
					duration,
					width: videoStream.width ?? 0,
					height: videoStream.height ?? 0,
					fps: Math.round(fps * 100) / 100,
					videoCodec: videoStream.codec_name ?? "unknown",
					audioCodec: audioStream?.codec_name ?? null,
					audioChannels: audioStream?.channels ?? null,
					sampleRate: audioStream?.sample_rate
						? Number.parseInt(audioStream.sample_rate, 10)
						: null,
					bitrate,
					fileSize,
				};
			})(),
			PROBE_TIMEOUT_MS,
			() => killProcess(proc),
		);

		return result;
	} finally {
		activeProbeProcesses--;
		killProcess(proc);
	}
}

export async function checkVideoAccessible(videoUrl: string): Promise<boolean> {
	try {
		const response = await fetch(videoUrl, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
