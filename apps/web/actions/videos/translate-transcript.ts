"use server";

import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { runPromise } from "@/lib/server";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "./translation-languages";

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

	const groq = getGroqClient();
	if (!groq) {
		return {
			success: false,
			message: "Translation service not configured",
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

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video not found" };
	}

	const { video } = query[0];

	const translatedKey = `${video.ownerId}/${videoId}/transcription.${targetLanguage}.vtt`;

	try {
		const existingTranslation = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(query[0]?.bucket?.id),
			);
			return yield* bucket.getObject(translatedKey);
		}).pipe(runPromise);

		if (Option.isSome(existingTranslation)) {
			return {
				success: true,
				translatedVtt: existingTranslation.value,
				message: "Retrieved cached translation",
			};
		}
	} catch (e) {
		console.debug("[translateTranscript] No cached translation found:", e);
	}

	const originalVtt = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(
			Option.fromNullable(query[0]?.bucket?.id),
		);
		return yield* bucket.getObject(
			`${video.ownerId}/${videoId}/transcription.vtt`,
		);
	}).pipe(runPromise);

	if (Option.isNone(originalVtt)) {
		return { success: false, message: "Original transcript not found" };
	}

	const translatedVtt = await translateVttContent(
		originalVtt.value,
		targetLanguage,
		groq,
	);

	if (!translatedVtt) {
		return { success: false, message: "Translation failed" };
	}

	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(query[0]?.bucket?.id),
			);
			yield* bucket.putObject(translatedKey, translatedVtt, {
				contentType: "text/vtt",
			});
		}).pipe(runPromise);
	} catch (error) {
		console.error("[translateTranscript] Failed to cache translation:", error);
	}

	return {
		success: true,
		translatedVtt,
		message: "Translation completed",
	};
}

async function translateVttContent(
	vttContent: string,
	targetLanguage: LanguageCode,
	groq: NonNullable<ReturnType<typeof getGroqClient>>,
): Promise<string | null> {
	const targetLanguageName = SUPPORTED_LANGUAGES[targetLanguage];

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

${vttContent}`;

	try {
		const response = await groq.chat.completions.create({
			model: GROQ_MODEL,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.3,
			max_tokens: 8000,
		});

		const content = response.choices[0]?.message?.content;
		if (content?.includes("WEBVTT")) {
			return content.trim();
		}

		return null;
	} catch (error) {
		console.error("[translateVttContent] Translation error:", error);
		return null;
	}
}
