import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "@/lib/audio-extract";

export interface VideoConversionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

function runFfmpeg(args: string[]): Promise<void> {
	const ffmpeg = getFfmpegPath();

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Video conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`Video conversion failed with code ${code}: ${stderr}`));
		});
	});
}

async function convertRemoteVideoToMp4FileInternal(
	videoUrl: string,
	outputPath: string,
): Promise<void> {
	try {
		await runFfmpeg([
			"-y",
			"-i",
			videoUrl,
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			outputPath,
		]);
	} catch {
		await runFfmpeg([
			"-y",
			"-i",
			videoUrl,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			outputPath,
		]);
	}
}

export async function convertRemoteVideoToMp4(
	videoUrl: string,
): Promise<VideoConversionResult> {
	const filePath = join(tmpdir(), `video-${randomUUID()}.mp4`);

	try {
		await convertRemoteVideoToMp4FileInternal(videoUrl, filePath);

		return {
			filePath,
			mimeType: "video/mp4",
			cleanup: async () => {
				try {
					await fs.unlink(filePath);
				} catch {}
			},
		};
	} catch (error) {
		await fs.unlink(filePath).catch(() => {});
		throw error;
	}
}

export async function convertRemoteVideoToMp4Buffer(
	videoUrl: string,
): Promise<Buffer> {
	const result = await convertRemoteVideoToMp4(videoUrl);

	try {
		return await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}
}
