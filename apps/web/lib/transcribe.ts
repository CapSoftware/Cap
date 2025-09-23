import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import { eq } from "drizzle-orm";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { createBucketProvider } from "@/utils/s3";

type TranscribeResult = {
	success: boolean;
	message: string;
};

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().DEEPGRAM_API_KEY) {
		return {
			success: false,
			message: "Missing necessary environment variables",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId));

	const bucket = await createBucketProvider(result.bucket);

	try {
		const videoKey = `${userId}/${videoId}/result.mp4`;

		const videoUrl = await bucket.getSignedObjectUrl(videoKey);

		// Check if video file actually exists before transcribing
		try {
			const headResponse = await fetch(videoUrl, {
				method: "GET",
				headers: { range: "bytes=0-0" },
			});
			if (!headResponse.ok) {
				// Video not ready yet - reset to null for retry
				await db()
					.update(videos)
					.set({ transcriptionStatus: null })
					.where(eq(videos.id, videoId));

				return {
					success: false,
					message: "Video file not ready yet - will retry automatically",
				};
			}
		} catch {
			console.log(
				`[transcribeVideo] Video file not accessible yet for ${videoId}, will retry later`,
			);
			await db()
				.update(videos)
				.set({ transcriptionStatus: null })
				.where(eq(videos.id, videoId));

			return {
				success: false,
				message: "Video file not ready yet - will retry automatically",
			};
		}

		const transcription = await transcribeAudio(videoUrl);

		// Note: Empty transcription is valid for silent videos (just contains "WEBVTT\n\n")
		if (transcription === "") {
			throw new Error("Failed to transcribe audio");
		}

		await bucket.putObject(
			`${userId}/${videoId}/transcription.vtt`,
			transcription,
			{ contentType: "text/vtt" },
		);

		await db()
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, videoId));

		console.log(
			`[transcribeVideo] Transcription completed for video ${videoId}`,
		);

		if (aiGenerationEnabled) {
			console.log(
				`[transcribeVideo] AI generation enabled, triggering AI metadata generation for video ${videoId}`,
			);
			try {
				generateAiMetadata(videoId, userId).catch((error) => {
					console.error(
						`[transcribeVideo] Error generating AI metadata for video ${videoId}:`,
						error,
					);
				});
			} catch (error) {
				console.error(
					`[transcribeVideo] Error starting AI metadata generation for video ${videoId}:`,
					error,
				);
			}
		} else {
			console.log(
				`[transcribeVideo] AI generation disabled, skipping AI metadata generation for video ${videoId}`,
			);
		}

		return {
			success: true,
			message: "VTT file generated and uploaded successfully",
		};
	} catch (error) {
		console.error("Error transcribing video:", error);

		// Determine if this is a temporary or permanent error
		const errorMessage = error instanceof Error ? error.message : String(error);
		const isTemporaryError =
			errorMessage.includes("not found") ||
			errorMessage.includes("access denied") ||
			errorMessage.includes("network") ||
			!isRetry; // First attempt failures are often temporary

		const newStatus = isTemporaryError ? null : "ERROR";

		await db()
			.update(videos)
			.set({ transcriptionStatus: newStatus })
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: isTemporaryError
				? "Video not ready - will retry"
				: "Transcription failed permanently",
		};
	}
}

function formatToWebVTT(result: any): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;

	// Handle case where there are no utterances (silent video)
	if (!result.results.utterances || result.results.utterances.length === 0) {
		console.log(
			"[formatToWebVTT] No utterances found - video appears to be silent",
		);
		return output; // Return valid but empty VTT file
	}

	result.results.utterances.forEach((utterance: any) => {
		const words = utterance.words;
		let group = [];
		let start = formatTimestamp(words[0].start);
		let wordCount = 0;

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			group.push(word.word);
			wordCount++;

			if (
				word.punctuated_word.endsWith(",") ||
				word.punctuated_word.endsWith(".") ||
				(words[i + 1] && words[i + 1].start - word.end > 0.5) ||
				wordCount === 8
			) {
				const end = formatTimestamp(word.end);
				const groupText = group.join(" ");

				output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
				captionIndex++;

				group = [];
				start = words[i + 1] ? formatTimestamp(words[i + 1].start) : start;
				wordCount = 0;
			}
		}
	});

	return output;
}

function formatTimestamp(seconds: number): string {
	const date = new Date(seconds * 1000);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const secs = date.getUTCSeconds().toString().padStart(2, "0");
	const millis = (date.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5);

	return `${hours}:${minutes}:${secs}.${millis}`;
}

async function transcribeAudio(videoUrl: string): Promise<string> {
	console.log("[transcribeAudio] Starting transcription for URL:", videoUrl);
	const deepgram = createClient(serverEnv().DEEPGRAM_API_KEY as string);

	const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
		{
			url: videoUrl,
		},
		{
			model: "nova-3",
			smart_format: true,
			detect_language: true,
			utterances: true,
			mime_type: "video/mp4",
		},
	);

	if (error) {
		console.error("[transcribeAudio] Deepgram transcription error:", error);
		return "";
	}

	console.log(
		"[transcribeAudio] Transcription result received, formatting to WebVTT",
	);
	const captions = formatToWebVTT(result);

	console.log("[transcribeAudio] Transcription complete, returning captions");
	return captions;
}
