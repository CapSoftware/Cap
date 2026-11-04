"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { isAiConfigured } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "./translation-languages";
import {
	isCompleteTranslation,
	joinTranslationChunks,
	readCachedTranslation,
	sourceDigest,
	splitTranslationChunks,
	withSourceFingerprint,
} from "./translation-vtt";

interface TranslateResult {
	success: boolean;
	translatedVtt?: string;
	message: string;
}

export async function translateTranscript(
	videoId: Video.VideoId,
	targetLanguage: LanguageCode,
): Promise<TranslateResult> {
	if (!videoId || !targetLanguage) {
		return {
			success: false,
			message: "Missing required parameters",
		};
	}

	if (!SUPPORTED_LANGUAGES[targetLanguage]) {
		return {
			success: false,
			message: "Unsupported language",
		};
	}

	if (!isAiConfigured()) {
		return {
			success: false,
			message: "Translation service not configured",
		};
	}

	if (await isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT)) {
		return { success: false, message: "Too many requests" };
	}

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select({ video: videos }).from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) {
		return { success: false, message: "Video not found" };
	}

	const query = exit.value;

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video not found" };
	}

	const { video } = query[0];

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const originalVtt = await bucket
		.getObject(`${video.ownerId}/${videoId}/transcription.vtt`)
		.pipe(runPromise);

	if (Option.isNone(originalVtt)) {
		return { success: false, message: "Original transcript not found" };
	}

	const pairKey = `${videoId}:${targetLanguage}:${sourceDigest(originalVtt.value)}`;
	const running = translationsInFlight.get(pairKey);
	if (running) return running;

	const translation = translateOnce({
		bucket,
		pairKey,
		source: originalVtt.value,
		targetLanguage,
		translatedKey: `${video.ownerId}/${videoId}/transcription.${targetLanguage}.vtt`,
		attemptKey: `${video.ownerId}/${videoId}/translation-status/${targetLanguage}.json`,
	}).finally(() => translationsInFlight.delete(pairKey));
	translationsInFlight.set(pairKey, translation);
	return translation;
}

type VideoBucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

interface PairTranslation {
	bucket: VideoBucket;
	pairKey: string;
	source: string;
	targetLanguage: LanguageCode;
	translatedKey: string;
	attemptKey: string;
}

interface TranslationAttempt {
	state: "pending" | "failed";
	source: string;
	at: number;
}

// A pass cannot outlive its function invocation (Vercel's default 300 s limit),
// so an older pending marker belongs to a pass that was stopped.
const PENDING_TRANSLATION_LEASE_MS = 5 * 60 * 1000;
const FAILED_TRANSLATION_RETRY_MS = 10 * 60 * 1000;
const TRANSLATION_WAIT_MS = 20 * 1000;
const TRANSLATION_WAIT_POLL_MS = 2 * 1000;

const TRANSLATION_FAILED: TranslateResult = {
	success: false,
	message: "Translation failed",
};

const translationsInFlight = new Map<string, Promise<TranslateResult>>();
const recentTranslationFailures = new Map<string, number>();

function hasRecentFailure(pairKey: string) {
	const failedAt = recentTranslationFailures.get(pairKey);
	return (
		failedAt !== undefined &&
		Date.now() - failedAt < FAILED_TRANSLATION_RETRY_MS
	);
}

function recordFailure(pairKey: string, failedAt: number) {
	for (const [key, value] of recentTranslationFailures) {
		if (Date.now() - value >= FAILED_TRANSLATION_RETRY_MS) {
			recentTranslationFailures.delete(key);
		}
	}
	recentTranslationFailures.set(pairKey, failedAt);
}

async function readStoredTranslation(translation: PairTranslation) {
	try {
		const existing = await translation.bucket
			.getObject(translation.translatedKey)
			.pipe(runPromise);
		return Option.isSome(existing)
			? readCachedTranslation(translation.source, existing.value)
			: null;
	} catch (e) {
		console.debug("[translateTranscript] No cached translation found:", e);
		return null;
	}
}

function parseAttempt(body: string): TranslationAttempt | null {
	try {
		const value = JSON.parse(body) as Partial<TranslationAttempt>;
		if (
			(value.state === "pending" || value.state === "failed") &&
			typeof value.source === "string" &&
			typeof value.at === "number"
		) {
			return { state: value.state, source: value.source, at: value.at };
		}
	} catch {}
	return null;
}

async function readAttempt(
	translation: PairTranslation,
): Promise<TranslationAttempt | null> {
	if (translation.bucket.provider !== "s3") return null;
	try {
		const stored = await translation.bucket
			.getObject(translation.attemptKey)
			.pipe(runPromise);
		const attempt = Option.isSome(stored) ? parseAttempt(stored.value) : null;
		if (!attempt || attempt.source !== sourceDigest(translation.source)) {
			return null;
		}
		const ttl =
			attempt.state === "pending"
				? PENDING_TRANSLATION_LEASE_MS
				: FAILED_TRANSLATION_RETRY_MS;
		return Date.now() - attempt.at < ttl ? attempt : null;
	} catch (error) {
		console.warn("[translateTranscript] Could not read attempt:", error);
		return null;
	}
}

async function writeAttempt(
	translation: PairTranslation,
	state: TranslationAttempt["state"],
) {
	if (translation.bucket.provider !== "s3") return;
	const attempt: TranslationAttempt = {
		state,
		source: sourceDigest(translation.source),
		at: Date.now(),
	};
	try {
		await translation.bucket
			.putObject(translation.attemptKey, JSON.stringify(attempt), {
				contentType: "application/json",
			})
			.pipe(runPromise);
	} catch (error) {
		console.warn("[translateTranscript] Could not record attempt:", error);
	}
}

async function clearAttempt(translation: PairTranslation) {
	if (translation.bucket.provider !== "s3") return;
	try {
		await translation.bucket
			.deleteObject(translation.attemptKey)
			.pipe(runPromise);
	} catch (error) {
		console.warn("[translateTranscript] Could not clear attempt:", error);
	}
}

async function waitForTranslation(
	translation: PairTranslation,
): Promise<TranslateResult> {
	const deadline = Date.now() + TRANSLATION_WAIT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) =>
			setTimeout(resolve, TRANSLATION_WAIT_POLL_MS),
		);
		const stored = await readStoredTranslation(translation);
		if (stored) {
			return {
				success: true,
				translatedVtt: stored,
				message: "Retrieved cached translation",
			};
		}
		const attempt = await readAttempt(translation);
		if (attempt?.state === "failed") {
			recordFailure(translation.pairKey, attempt.at);
			return TRANSLATION_FAILED;
		}
		if (!attempt) break;
	}
	return { success: false, message: "Translation in progress" };
}

async function translateOnce(
	translation: PairTranslation,
): Promise<TranslateResult> {
	const stored = await readStoredTranslation(translation);
	if (stored) {
		return {
			success: true,
			translatedVtt: stored,
			message: "Retrieved cached translation",
		};
	}

	if (hasRecentFailure(translation.pairKey)) return TRANSLATION_FAILED;

	const attempt = await readAttempt(translation);
	if (attempt?.state === "failed") {
		recordFailure(translation.pairKey, attempt.at);
		return TRANSLATION_FAILED;
	}
	if (attempt?.state === "pending") return waitForTranslation(translation);

	await writeAttempt(translation, "pending");

	const translatedVtt = await translateVttContent(
		translation.source,
		translation.targetLanguage,
	);

	if (!translatedVtt) {
		recordFailure(translation.pairKey, Date.now());
		await writeAttempt(translation, "failed");
		return TRANSLATION_FAILED;
	}

	const cacheBody = withSourceFingerprint(translation.source, translatedVtt);
	if (cacheBody) {
		try {
			await translation.bucket
				.putObject(translation.translatedKey, cacheBody, {
					contentType: "text/vtt",
				})
				.pipe(runPromise);
		} catch (error) {
			console.error(
				"[translateTranscript] Failed to cache translation:",
				error,
			);
		}
	}
	await clearAttempt(translation);

	return {
		success: true,
		translatedVtt,
		message: "Translation completed",
	};
}

async function translateVttContent(
	vttContent: string,
	targetLanguage: LanguageCode,
): Promise<string | null> {
	const targetLanguageName = SUPPORTED_LANGUAGES[targetLanguage];
	const chunks = splitTranslationChunks(vttContent);
	if (!chunks) return null;

	const translations: string[] = [];
	for (const chunk of chunks) {
		const prompt = `Translate the following WebVTT subtitle file to ${targetLanguageName}.

IMPORTANT RULES:
1. Keep the "WEBVTT" header exactly as is
2. Keep all timestamp lines exactly as they are (e.g., "00:00:01.234 --> 00:00:03.456")
3. Keep all cue numbers exactly as they are
4. Only translate the actual text content on each line
5. Preserve all newlines and formatting
6. Do not add any explanations or comments
7. Return ONLY the translated VTT content

VTT content to translate:

${chunk}`;

		try {
			const translatedChunk = await runWithAiProviders(
				"generation",
				async (selection) => {
					const response = await generateText({
						model: selection.model(),
						prompt,
						maxOutputTokens: 8000,
						...(selection.supportsTemperature ? { temperature: 0.3 } : {}),
					});

					if (
						response.finishReason === "length" ||
						!isCompleteTranslation(chunk, response.text)
					) {
						throw new Error("translation response has missing or changed cues");
					}

					return response.text.trim();
				},
			);
			translations.push(translatedChunk);
		} catch (error) {
			console.error("[translateVttContent] Translation error:", error);
			return null;
		}
	}

	return joinTranslationChunks(vttContent, chunks, translations);
}
