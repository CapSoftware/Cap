import { spawn } from "node:child_process";
import { serverEnv } from "@cap/env";
import Replicate from "replicate";
import { getFfmpegPath } from "./audio-extract";

const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 5000;

export const ENHANCED_AUDIO_EXTENSION = "mp3";
export const ENHANCED_AUDIO_CONTENT_TYPE = "audio/mpeg";

export function isAudioEnhancementConfigured(): boolean {
	return !!serverEnv().REPLICATE_API_TOKEN;
}

async function streamConvertToMp3(wavUrl: string): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		wavUrl,
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
			reject(new Error(`Audio conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(`Audio conversion failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export async function enhanceAudioFromUrl(audioUrl: string): Promise<Buffer> {
	const apiToken = serverEnv().REPLICATE_API_TOKEN;
	if (!apiToken) {
		throw new Error("REPLICATE_API_TOKEN is not configured");
	}

	const replicate = new Replicate({
		auth: apiToken,
	});

	const prediction = await replicate.predictions.create({
		version: "93266a7e7f5805fb79bcf213b1a4e0ef2e45aff3c06eefd96c59e850c87fd6a2",
		input: {
			input_audio: audioUrl,
		},
	});

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

	const output = result.output as string[] | undefined;
	const enhancedAudioUrl = output?.[0];
	if (!enhancedAudioUrl) {
		throw new Error("No output received from Replicate");
	}

	const mp3Buffer = await streamConvertToMp3(enhancedAudioUrl);

	return mp3Buffer;
}
