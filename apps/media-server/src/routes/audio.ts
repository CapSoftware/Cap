import { Hono } from "hono";
import { z } from "zod";
import { checkHasAudioTrack, extractAudio } from "../lib/ffmpeg";

const audio = new Hono();

const videoUrlSchema = z.object({
	videoUrl: z.string().url(),
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
		if (!hasAudio) {
			return c.json(
				{ error: "Video has no audio track", code: "NO_AUDIO_TRACK" },
				422,
			);
		}

		const audioData = await extractAudio(result.data.videoUrl);

		return new Response(Buffer.from(audioData), {
			headers: {
				"Content-Type": "audio/mp4",
				"Content-Length": audioData.length.toString(),
			},
		});
	} catch (err) {
		console.error("[audio/extract] Error:", err);
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
