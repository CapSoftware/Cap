import { Hono } from "hono";
import { z } from "zod";
import {
	canAcceptNewProcess,
	checkHasAudioTrack,
	extractAudio,
	extractAudioStream,
	getActiveProcessCount,
} from "../lib/ffmpeg";

const audio = new Hono();

const videoUrlSchema = z.object({
	videoUrl: z.string().url(),
});

const extractSchema = z.object({
	videoUrl: z.string().url(),
	stream: z.boolean().optional().default(true),
});

function isBusyError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Server is busy");
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("timed out");
}

audio.get("/status", (c) => {
	return c.json({
		activeProcesses: getActiveProcessCount(),
		canAcceptNewProcess: canAcceptNewProcess(),
	});
});

audio.post("/check", async (c) => {
	const body = await c.req.json();
	const result = videoUrlSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	try {
		const hasAudio = await checkHasAudioTrack(result.data.videoUrl);
		return c.json({ hasAudio });
	} catch (err) {
		console.error("[audio/check] Error:", err);

		if (isBusyError(err)) {
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: "Too many concurrent requests, please retry later",
				},
				503,
			);
		}

		if (isTimeoutError(err)) {
			return c.json(
				{
					error: "Request timed out",
					code: "TIMEOUT",
					details: err instanceof Error ? err.message : String(err),
				},
				504,
			);
		}

		return c.json(
			{
				error: "Failed to check audio track",
				code: "FFMPEG_ERROR",
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

audio.post("/extract", async (c) => {
	const body = await c.req.json();
	const result = extractSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	const { videoUrl, stream: useStreaming } = result.data;

	try {
		const hasAudio = await checkHasAudioTrack(videoUrl);
		if (!hasAudio) {
			return c.json(
				{ error: "Video has no audio track", code: "NO_AUDIO_TRACK" },
				422,
			);
		}

		if (useStreaming) {
			const { stream, cleanup } = extractAudioStream(videoUrl);

			c.req.raw.signal.addEventListener("abort", () => {
				cleanup();
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "audio/mpeg",
					"Transfer-Encoding": "chunked",
				},
			});
		}

		const audioData = await extractAudio(videoUrl);

		return new Response(Buffer.from(audioData), {
			headers: {
				"Content-Type": "audio/mpeg",
				"Content-Length": audioData.length.toString(),
			},
		});
	} catch (err) {
		console.error("[audio/extract] Error:", err);

		if (isBusyError(err)) {
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: "Too many concurrent requests, please retry later",
				},
				503,
			);
		}

		if (isTimeoutError(err)) {
			return c.json(
				{
					error: "Request timed out",
					code: "TIMEOUT",
					details: err instanceof Error ? err.message : String(err),
				},
				504,
			);
		}

		return c.json(
			{
				error: "Failed to extract audio",
				code: "FFMPEG_ERROR",
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

export default audio;
