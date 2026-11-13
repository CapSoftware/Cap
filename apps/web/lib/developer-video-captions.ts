import { db } from "@cap/database";
import { developerTranscripts, developerVideos } from "@cap/database/schema";
import type { DeveloperVideoStatus } from "@cap/database/types";
import { isLanguageCode, SUPPORTED_LANGUAGES } from "@cap/web-domain";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
	getDeveloperObjectText,
	putDeveloperObject,
	removeDeveloperObject,
} from "@/lib/developer-transcript-storage";
import { buildWebVtt } from "@/lib/developer-transcript-vtt";
import type { TranscriptResultObject } from "@/lib/developer-transcripts";
import { developerVideoKeys } from "@/lib/developer-video-plan";

export const CAPTIONS_CONTENT_TYPE = "text/vtt; charset=utf-8";
export const CAPTIONS_UNKNOWN_LANGUAGE = "und";

const SYNC_ATTEMPTS = 5;

export type DeveloperVideoCaption = {
	language: string;
	label: string;
	key: string;
};

type VideoRef = { id: string; appId: string };

export function captionLanguage(language: string | null | undefined) {
	const value = (language ?? "").trim().toLowerCase().replaceAll("_", "-");
	return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(value)
		? value
		: CAPTIONS_UNKNOWN_LANGUAGE;
}

export function captionLanguageLabel(language: string) {
	if (isLanguageCode(language)) return SUPPORTED_LANGUAGES[language];
	if (language === CAPTIONS_UNKNOWN_LANGUAGE) return "Captions";
	try {
		return (
			new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
			language
		);
	} catch {
		return language;
	}
}

export function videoCaptionsKey(video: VideoRef, language: string) {
	return `developer/${video.appId}/${video.id}/captions/${captionLanguage(language)}.vtt`;
}

const captionSources = (video: VideoRef) =>
	and(
		eq(developerTranscripts.appId, video.appId),
		eq(developerTranscripts.videoId, video.id),
		eq(developerTranscripts.status, "complete"),
		isNull(developerTranscripts.deletedAt),
		gt(developerTranscripts.wordCount, 0),
	);

export async function developerVideoCaptions(
	video: VideoRef,
): Promise<DeveloperVideoCaption[]> {
	const rows = await db()
		.selectDistinct({ language: developerTranscripts.language })
		.from(developerTranscripts)
		.where(captionSources(video));
	const languages = [
		...new Set(rows.map((row) => captionLanguage(row.language))),
	];
	return languages
		.map((language) => ({
			language,
			label: captionLanguageLabel(language),
			key: videoCaptionsKey(video, language),
		}))
		.sort((a, b) =>
			a.label === b.label
				? a.language.localeCompare(b.language)
				: a.label.localeCompare(b.label),
		);
}

async function newestCaptionSource(video: VideoRef, language: string) {
	const stored = await db()
		.selectDistinct({ language: developerTranscripts.language })
		.from(developerTranscripts)
		.where(captionSources(video));
	const matching = stored
		.map((row) => row.language)
		.filter((value) => captionLanguage(value) === language);
	if (matching.length === 0) return null;
	const named = matching.filter((value): value is string => value !== null);
	const [row] = await db()
		.select({
			id: developerTranscripts.id,
			resultKey: developerTranscripts.resultKey,
		})
		.from(developerTranscripts)
		.where(
			and(
				captionSources(video),
				or(
					named.length > 0
						? inArray(developerTranscripts.language, named)
						: undefined,
					named.length < matching.length
						? isNull(developerTranscripts.language)
						: undefined,
				),
			),
		)
		.orderBy(
			desc(developerTranscripts.createdAt),
			desc(developerTranscripts.id),
		)
		.limit(1);
	return row ?? null;
}

async function videoIsStored(video: VideoRef) {
	const [row] = await db()
		.select({ deletedAt: developerVideos.deletedAt })
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, video.id),
				eq(developerVideos.appId, video.appId),
			),
		)
		.limit(1);
	return row !== undefined && !row.deletedAt;
}

async function captionsFor(resultKey: string | null) {
	if (!resultKey) return null;
	const stored = await getDeveloperObjectText(resultKey);
	if (stored === null) return null;
	try {
		const result = JSON.parse(stored) as TranscriptResultObject;
		return buildWebVtt(result.words, result.durationSeconds);
	} catch {
		return null;
	}
}

export async function syncVideoCaptions(input: {
	appId: string;
	videoId: string;
	language: string | null;
}): Promise<{ state: "written"; transcriptId: string } | { state: "removed" }> {
	const video = { id: input.videoId, appId: input.appId };
	const language = captionLanguage(input.language);
	const key = videoCaptionsKey(video, language);

	const currentSource = async () =>
		(await videoIsStored(video))
			? await newestCaptionSource(video, language)
			: null;

	for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
		const source = await currentSource();
		const captions = source ? await captionsFor(source.resultKey) : null;
		if (source && captions !== null) {
			await putDeveloperObject(key, captions, CAPTIONS_CONTENT_TYPE);
		} else {
			await removeDeveloperObject(key);
		}
		const latest = await currentSource();
		if ((latest?.id ?? null) === (source?.id ?? null)) {
			return source && captions !== null
				? { state: "written", transcriptId: source.id }
				: { state: "removed" };
		}
	}
	throw new Error(
		`Captions for video ${video.id} kept changing while they were written`,
	);
}

export type VideoForTranscript =
	| {
			state: "ok";
			name: string;
			sourceKey: string;
			durationSeconds: number | null;
	  }
	| { state: "not_found" }
	| { state: "not_ready"; status: DeveloperVideoStatus; hasFile: boolean };

export async function findVideoForTranscript(
	appId: string,
	videoId: string,
): Promise<VideoForTranscript> {
	const [video] = await db()
		.select({
			id: developerVideos.id,
			appId: developerVideos.appId,
			name: developerVideos.name,
			status: developerVideos.status,
			duration: developerVideos.duration,
			processing: developerVideos.processing,
			deletedAt: developerVideos.deletedAt,
			filesDeletedAt: developerVideos.filesDeletedAt,
		})
		.from(developerVideos)
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		)
		.limit(1);
	if (!video || video.deletedAt) return { state: "not_found" };

	const { processing } = video;
	const mp4 = processing?.mp4;
	if (
		video.status !== "ready" ||
		!processing ||
		mp4?.state !== "complete" ||
		video.filesDeletedAt
	) {
		return {
			state: "not_ready",
			status: video.status,
			hasFile: mp4?.state === "complete" && !video.filesDeletedAt,
		};
	}
	return {
		state: "ok",
		name: video.name,
		sourceKey: developerVideoKeys(video, processing.encodeId, mp4.output).mp4,
		durationSeconds:
			typeof video.duration === "number" && video.duration > 0
				? video.duration
				: null,
	};
}
