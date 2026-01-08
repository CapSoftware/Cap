import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { path as ffmpegPath } from "@ffmpeg-installer/ffmpeg";
import ffmpeg, { type FfprobeData } from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath);

export interface AudioExtractionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

export async function extractAudioFromUrl(
	videoUrl: string,
): Promise<AudioExtractionResult> {
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.m4a`);

	return new Promise((resolve, reject) => {
		ffmpeg(videoUrl)
			.noVideo()
			.audioCodec("aac")
			.audioBitrate("128k")
			.format("ipod")
			.outputOptions(["-movflags", "+faststart"])
			.on("start", (commandLine: string) => {
				console.log("[audio-extract] FFmpeg started:", commandLine);
			})
			.on("progress", (progress: { percent?: number }) => {
				if (progress.percent) {
					console.log(
						`[audio-extract] Processing: ${progress.percent.toFixed(1)}%`,
					);
				}
			})
			.on("error", (err: Error) => {
				console.error("[audio-extract] FFmpeg error:", err);
				fs.unlink(outputPath).catch(() => {});
				reject(new Error(`Audio extraction failed: ${err.message}`));
			})
			.on("end", () => {
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
			})
			.save(outputPath);
	});
}

export async function extractAudioToBuffer(videoUrl: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];

		ffmpeg(videoUrl)
			.noVideo()
			.audioCodec("aac")
			.audioBitrate("128k")
			.format("ipod")
			.outputOptions(["-movflags", "+frag_keyframe+empty_moov"])
			.on("error", (err: Error) => {
				console.error("[audio-extract] FFmpeg error:", err);
				reject(new Error(`Audio extraction failed: ${err.message}`));
			})
			.pipe()
			.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			})
			.on("end", () => {
				console.log("[audio-extract] Audio extraction to buffer complete");
				resolve(Buffer.concat(chunks));
			})
			.on("error", (err: Error) => {
				reject(new Error(`Stream error: ${err.message}`));
			});
	});
}

export async function checkHasAudioTrack(videoUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		ffmpeg.ffprobe(videoUrl, (err: Error | null, metadata: FfprobeData) => {
			if (err) {
				console.error("[audio-extract] ffprobe error:", err);
				resolve(false);
				return;
			}

			const hasAudio = metadata.streams.some(
				(stream) => stream.codec_type === "audio",
			);
			console.log(`[audio-extract] Video has audio track: ${hasAudio}`);
			resolve(hasAudio);
		});
	});
}
