import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

let cachedFfmpegPath: string | null = null;

function getFfmpegPath(): string {
	if (cachedFfmpegPath) {
		return cachedFfmpegPath;
	}

	const candidatePaths = [
		ffmpegStaticPath,
		resolve(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
		resolve(
			process.cwd(),
			"node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
		),
		"/var/task/node_modules/ffmpeg-static/ffmpeg",
		"/var/task/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
	].filter(Boolean) as string[];

	for (const path of candidatePaths) {
		if (existsSync(path)) {
			cachedFfmpegPath = path;
			return path;
		}
	}

	throw new Error(
		`FFmpeg binary not found. Tried paths: ${candidatePaths.join(", ")}`,
	);
}

export interface AudioExtractionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

export async function extractAudioFromUrl(
	videoUrl: string,
): Promise<AudioExtractionResult> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.mp3`);

	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({
					filePath: outputPath,
					mimeType: "audio/mpeg",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
						} catch {}
					},
				});
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(new Error(`Audio extraction failed with code ${code}: ${stderr}`));
			}
		});
	});
}

export async function extractAudioToBuffer(videoUrl: string): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-pipe:1",
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		const chunks: Buffer[] = [];
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(new Error(`Audio extraction failed with code ${code}: ${stderr}`));
			}
		});
	});
}

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch {
		return false;
	}
	const ffmpegArgs = ["-i", videoUrl, "-hide_banner"];

	return new Promise((resolve) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", () => {
			resolve(false);
		});

		proc.on("close", () => {
			resolve(/Stream #\d+:\d+.*Audio:/.test(stderr));
		});
	});
}
