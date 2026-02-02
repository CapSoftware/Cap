import { serverEnv } from "@cap/env";
import Replicate from "replicate";
import {
	convertAudioToMp3ViaMediaServer,
	isMediaServerConfigured,
} from "./media-client";

const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 5000;

export const ENHANCED_AUDIO_EXTENSION = "mp3";
export const ENHANCED_AUDIO_CONTENT_TYPE = "audio/mpeg";

export function isAudioEnhancementConfigured(): boolean {
	const hasReplicateToken = !!serverEnv().REPLICATE_API_TOKEN;
	const hasMediaServer = isMediaServerConfigured();

	console.log(
		`[audio-enhance] Config check: REPLICATE_API_TOKEN=${hasReplicateToken}, MEDIA_SERVER_URL=${hasMediaServer}`,
	);

	return hasReplicateToken && hasMediaServer;
}

export async function enhanceAudioFromUrl(audioUrl: string): Promise<Buffer> {
	console.log("[audio-enhance] Starting audio enhancement");

	const apiToken = serverEnv().REPLICATE_API_TOKEN;
	if (!apiToken) {
		throw new Error("REPLICATE_API_TOKEN is not configured");
	}

	if (!isMediaServerConfigured()) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}

	const replicate = new Replicate({
		auth: apiToken,
	});

	console.log("[audio-enhance] Creating Replicate prediction...");

	const prediction = await replicate.predictions.create({
		version: "93266a7e7f5805fb79bcf213b1a4e0ef2e45aff3c06eefd96c59e850c87fd6a2",
		input: {
			input_audio: audioUrl,
		},
	});

	console.log(`[audio-enhance] Prediction created: ${prediction.id}`);

	let result = prediction;
	let attempts = 0;

	while (
		result.status !== "succeeded" &&
		result.status !== "failed" &&
		result.status !== "canceled" &&
		attempts < MAX_POLL_ATTEMPTS
	) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		result = await replicate.predictions.get(prediction.id);
		attempts++;
	}

	if (result.status === "failed") {
		throw new Error(`Replicate enhancement failed: ${result.error}`);
	}

	if (result.status === "canceled") {
		throw new Error("Replicate enhancement was canceled");
	}

	if (result.status !== "succeeded") {
		throw new Error("Replicate enhancement timed out");
	}

	console.log(
		`[audio-enhance] Replicate completed after ${attempts} poll attempts`,
	);

	const output = result.output as string[] | undefined;
	const enhancedAudioUrl = output?.[0];
	if (!enhancedAudioUrl) {
		throw new Error("No output received from Replicate");
	}

	console.log("[audio-enhance] Converting WAV to MP3 via media server...");

	const mp3Buffer = await convertAudioToMp3ViaMediaServer(enhancedAudioUrl);

	console.log(
		`[audio-enhance] Conversion complete, buffer size: ${mp3Buffer.length} bytes`,
	);

	return mp3Buffer;
}
