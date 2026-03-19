"use server";

import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "./translation-languages";

interface AvailableTranslation {
	code: LanguageCode;
	name: string;
}

interface GetAvailableTranslationsResult {
	success: boolean;
	hasOriginal: boolean;
	translations: AvailableTranslation[];
	message?: string;
}

export async function getAvailableTranslations(
	videoId: Video.VideoId,
): Promise<GetAvailableTranslationsResult> {
	if (!videoId) {
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Missing video ID",
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
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Video not found",
		};
	}

	const { video } = query[0];
	const prefix = `${video.ownerId}/${videoId}/transcription`;

	try {
		const result = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(query[0]?.bucket?.id),
			);

			const listResult = yield* bucket.listObjects({
				prefix,
				maxKeys: 50,
			});

			return listResult;
		}).pipe(runPromise);

		const contents = result.Contents || [];

		let hasOriginal = false;
		const translations: AvailableTranslation[] = [];

		for (const obj of contents) {
			const key = obj.Key;
			if (!key) continue;

			if (key.endsWith("/transcription.vtt")) {
				hasOriginal = true;
				continue;
			}

			const match = key.match(/transcription\.([a-z]{2})\.vtt$/);
			if (match) {
				const langCode = match[1] as LanguageCode;
				if (SUPPORTED_LANGUAGES[langCode]) {
					translations.push({
						code: langCode,
						name: SUPPORTED_LANGUAGES[langCode],
					});
				}
			}
		}

		return {
			success: true,
			hasOriginal,
			translations,
		};
	} catch (error) {
		console.error("[getAvailableTranslations] Error:", error);
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Failed to list translations",
		};
	}
}
