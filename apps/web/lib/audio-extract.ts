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
			console.log(`[audio-extract] Found FFmpeg at: ${path}`);
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
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.m4a`);

	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		"aac",
		"-b:a",
		"128k",
		"-f",
		"ipod",
		"-movflags",
		"+faststart",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		console.log(
			"[audio-extract] FFmpeg started:",
			ffmpeg,
			ffmpegArgs.join(" "),
		);

		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			console.error("[audio-extract] FFmpeg error:", err);
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				console.log("[audio-extract] Audio extraction complete");
				resolve({
					filePath: outputPath,
					mimeType: "audio/mp4",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
							console.log("[audio-extract] Cleaned up temp file:", outputPath);
						} catch {}
					},
				});
			} else {
				console.error("[audio-extract] FFmpeg stderr:", stderr);
				fs.unlink(outputPath).catch(() => {});
				reject(new Error(`Audio extraction failed with code ${code}`));
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
		"aac",
		"-b:a",
		"128k",
		"-f",
		"ipod",
		"-movflags",
		"+frag_keyframe+empty_moov",
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
			console.error("[audio-extract] FFmpeg error:", err);
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				console.log("[audio-extract] Audio extraction to buffer complete");
				resolve(Buffer.concat(chunks));
			} else {
				console.error("[audio-extract] FFmpeg stderr:", stderr);
				reject(new Error(`Audio extraction failed with code ${code}`));
			}
		});
	});
}

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch (err) {
		console.error("[audio-extract] FFmpeg binary not found:", err);
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

		proc.on("error", (err: Error) => {
			console.error("[audio-extract] FFmpeg error:", err);
			resolve(false);
		});

		proc.on("close", () => {
			const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);
			console.log(`[audio-extract] Video has audio track: ${hasAudio}`);
			resolve(hasAudio);
		});
	});
}
