import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

let cachedFfmpegPath: string | null = null;

function getPathCandidates(): string[] {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((segment) => join(segment, "ffmpeg"));
}

export function getFfmpegPath(): string {
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
		process.env.FFMPEG_PATH,
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg",
		...getPathCandidates(),
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
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
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
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export async function convertWavToMp3(wavBuffer: Buffer): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		"pipe:0",
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
			reject(new Error(`WAV to MP3 conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(
						`WAV to MP3 conversion failed with code ${code}: ${stderr}`,
					),
				);
			}
		});

		proc.stdin?.write(wavBuffer);
		proc.stdin?.end();
	});
}

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch (err) {
		console.error(
			`[checkHasAudioTrack] ffmpeg binary not found, cannot check audio track:`,
			err,
		);
		throw new Error("ffmpeg binary not available — cannot check audio track");
	}
	const ffmpegArgs = ["-i", videoUrl, "-hide_banner"];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			console.error(`[checkHasAudioTrack] ffmpeg process error:`, err);
			reject(new Error(`ffmpeg process error: ${err.message}`));
		});

		proc.on("close", () => {
			const hasVideo = /Stream #\d+:\d+.*Video:/.test(stderr);
			const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);

			if (!hasVideo) {
				console.error(
					`[checkHasAudioTrack] No video stream found — ffmpeg may not be able to read the file. stderr: ${stderr.substring(0, 500)}`,
				);
				reject(
					new Error(`ffmpeg could not read video file: no streams detected`),
				);
				return;
			}

			console.log(
				`[checkHasAudioTrack] Result: hasVideo=${hasVideo}, hasAudio=${hasAudio}`,
			);
			resolve(hasAudio);
		});
	});
}
