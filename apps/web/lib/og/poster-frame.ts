// Poster-frame fallback for video OG images. Screenshots are written by the
// media pipeline (process-video → screenshot/screen-capture.jpg) some time
// after upload, so fresh or unprocessed videos have none — extract a frame
// straight from the playable source instead.

import { spawn } from "node:child_process";
import { buildEnv } from "@cap/env";
import { getFfmpegPath } from "@/lib/audio-extract";

const OVERALL_DEADLINE_MS = 6500;
const MIN_ATTEMPT_MS = 800;

// `video` covers processed uploads and desktop recordings; `raw-preview` is
// the not-yet-processed upload the share page itself plays. Missing objects
// fail fast (the redirect target 404s), so the ladder costs little.
const SOURCE_LADDER = [
	{ videoType: "video", seek: "1" },
	{ videoType: "video", seek: "0" },
	{ videoType: "raw-preview", seek: "1" },
	{ videoType: "raw-preview", seek: "0" },
];

const grabFrame = (
	ffmpeg: string,
	url: string,
	seek: string,
	timeoutMs: number,
) =>
	new Promise<Buffer>((resolve, reject) => {
		const proc = spawn(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-ss",
				seek,
				"-i",
				url,
				"-frames:v",
				"1",
				"-vf",
				"scale=1120:-2",
				"-q:v",
				"4",
				"-f",
				"image2pipe",
				"-vcodec",
				"mjpeg",
				"pipe:1",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const chunks: Buffer[] = [];
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("poster frame extraction timed out"));
		}, timeoutMs);

		proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			const frame = Buffer.concat(chunks);
			if (code === 0 && frame.length > 0) resolve(frame);
			else
				reject(
					new Error(
						`ffmpeg exited ${code} with ${frame.length} bytes: ${stderr.slice(0, 300)}`,
					),
				);
		});
	});

/**
 * Extracts a poster frame for the video as a data URI, or undefined when no
 * playable source exists (yet). Bounded to ~6.5s across all attempts.
 */
export async function extractPosterFrameDataUri(
	videoId: string,
): Promise<string | undefined> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch {
		return undefined;
	}

	const deadline = Date.now() + OVERALL_DEADLINE_MS;
	for (const { videoType, seek } of SOURCE_LADDER) {
		const remaining = deadline - Date.now();
		if (remaining < MIN_ATTEMPT_MS) return undefined;

		const url = new URL(
			`/api/playlist?videoId=${videoId}&videoType=${videoType}`,
			buildEnv.NEXT_PUBLIC_WEB_URL,
		).toString();

		try {
			const frame = await grabFrame(ffmpeg, url, seek, remaining);
			return `data:image/jpeg;base64,${frame.toString("base64")}`;
		} catch {
			// Try the next source/seek combination.
		}
	}
	return undefined;
}
