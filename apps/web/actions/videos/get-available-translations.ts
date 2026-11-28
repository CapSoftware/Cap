"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	isLanguageCode,
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

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		const [video] = yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		);

		if (video) {
			yield* videosPolicy.canViewLoaded(
				video,
				Option.fromNullable(video.password),
			);
		}

		return video;
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit) || !exit.value) {
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Video not found",
		};
	}

	const video = exit.value;
	const prefix = `${video.ownerId}/${videoId}/transcription`;

	try {
		const result = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
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

			const match = key.match(/transcription\.([a-zA-Z-]+)\.vtt$/);
			if (match && isLanguageCode(match[1])) {
				const langCode = match[1];
				translations.push({
					code: langCode,
					name: SUPPORTED_LANGUAGES[langCode],
				});
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
