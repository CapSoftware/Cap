import { db } from "@cap/database";
import { developerTranscripts, developerVideos } from "@cap/database/schema";
import type { DeveloperVideoStatus } from "@cap/database/types";
import { isLanguageCode, SUPPORTED_LANGUAGES } from "@cap/web-domain";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
	getDeveloperObjectText,
	putDeveloperObject,
	removeDeveloperObject,
} from "@/lib/developer-transcript-storage";
import { buildWebVtt } from "@/lib/developer-transcript-vtt";
import {
	TRANSCRIPT_CAPTIONS_WRITTEN_KEY,
	type TranscriptResultObject,
	withCaptionsWritten,
} from "@/lib/developer-transcripts";
import { developerPlaybackBaseUrl } from "@/lib/developer-video-api";
import { developerVideoKeys } from "@/lib/developer-video-plan";

export const CAPTIONS_CONTENT_TYPE = "text/vtt; charset=utf-8";
export const CAPTIONS_UNKNOWN_LANGUAGE = "und";

const SYNC_ATTEMPTS = 5;

// A track is listed once its file is in storage, which the writer records on
// the transcript after the upload succeeds. Transcripts that completed before
// that record existed already have their file, so one that completed longer
// ago than this is listed without it.
export const CAPTIONS_UNMARKED_AFTER_MS = 10 * 60 * 1000;

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

const CAPTIONS_FILE_PATTERN = /^captions-([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.vtt$/;

export function captionsFileName(language: string) {
	return `captions-${captionLanguage(language)}.vtt`;
}

export function captionsFileLanguage(file: string): string | null {
	return file.match(CAPTIONS_FILE_PATTERN)?.[1] ?? null;
}

const CAPTIONS_PLAYLIST_PATTERN =
	/^captions-([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.m3u8$/;

export function captionsPlaylistName(language: string) {
	return `captions-${captionLanguage(language)}.m3u8`;
}

export function captionsPlaylistLanguage(file: string): string | null {
	return file.match(CAPTIONS_PLAYLIST_PATTERN)?.[1] ?? null;
}

const captionSources = (video: VideoRef) =>
	and(
		eq(developerTranscripts.appId, video.appId),
		eq(developerTranscripts.videoId, video.id),
		eq(developerTranscripts.status, "complete"),
		isNull(developerTranscripts.deletedAt),
		gt(developerTranscripts.wordCount, 0),
	);

const captionsInStorage = () =>
	or(
		sql`JSON_EXTRACT(${developerTranscripts.metadata}, '$.${sql.raw(TRANSCRIPT_CAPTIONS_WRITTEN_KEY)}') IS NOT NULL`,
		lt(
			developerTranscripts.completedAt,
			new Date(Date.now() - CAPTIONS_UNMARKED_AFTER_MS),
		),
	);

export async function developerVideoCaptions(
	video: VideoRef,
): Promise<DeveloperVideoCaption[]> {
	const rows = await db()
		.selectDistinct({ language: developerTranscripts.language })
		.from(developerTranscripts)
		.where(and(captionSources(video), captionsInStorage()));
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

export type DeveloperVideoCaptionTrack = {
	language: string;
	label: string;
	url: string;
};

// Captions are extra to playback, so a failed lookup leaves the video playing
// without them instead of failing the page.
export async function developerVideoCaptionTracks(
	video: VideoRef & { playbackId: string | null },
): Promise<DeveloperVideoCaptionTrack[]> {
	if (!video.playbackId) return [];
	try {
		const base = `${developerPlaybackBaseUrl()}/${video.playbackId}`;
		return (await developerVideoCaptions(video)).map(({ language, label }) => ({
			language,
			label,
			url: `${base}/${captionsFileName(language)}`,
		}));
	} catch (error) {
		console.error("[developer-video-captions] Failed to list captions", error);
		return [];
	}
}

export type DeveloperVideoCaptionLink = { language: string; url: string };

// One query for a page of videos, on the same rows the player reads. A failed
// lookup leaves captions out rather than failing the read.
export async function developerVideosCaptionLinks(
	appId: string,
	videos: { id: string; playbackId: string | null }[],
): Promise<Map<string, DeveloperVideoCaptionLink[]>> {
	const links = new Map<string, DeveloperVideoCaptionLink[]>();
	const playable = videos.filter((video) => video.playbackId !== null);
	if (playable.length === 0) return links;
	let rows: { videoId: string | null; language: string | null }[];
	try {
		rows = await db()
			.selectDistinct({
				videoId: developerTranscripts.videoId,
				language: developerTranscripts.language,
			})
			.from(developerTranscripts)
			.where(
				and(
					eq(developerTranscripts.appId, appId),
					inArray(
						developerTranscripts.videoId,
						playable.map((video) => video.id),
					),
					eq(developerTranscripts.status, "complete"),
					isNull(developerTranscripts.deletedAt),
					gt(developerTranscripts.wordCount, 0),
					captionsInStorage(),
				),
			);
	} catch (error) {
		console.error("[developer-video-captions] Failed to list captions", error);
		return links;
	}
	const base = developerPlaybackBaseUrl();
	for (const video of playable) {
		const languages = [
			...new Set(
				rows
					.filter((row) => row.videoId === video.id)
					.map((row) => captionLanguage(row.language)),
			),
		].sort();
		if (languages.length === 0) continue;
		links.set(
			video.id,
			languages.map((language) => ({
				language,
				url: `${base}/${video.playbackId}/${captionsFileName(language)}`,
			})),
		);
	}
	return links;
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
			desc(developerTranscripts.requestedAt),
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

async function markCaptionsWritten(transcriptId: string) {
	const [row] = await db()
		.select({
			metadata: developerTranscripts.metadata,
			updatedAt: developerTranscripts.updatedAt,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	if (!row) return;
	// Only Cap writes a transcript's metadata after it is created, so this
	// read and write cannot lose a client's change. updatedAt is kept, so the
	// record does not move the time the API reports.
	await db()
		.update(developerTranscripts)
		.set({
			metadata: withCaptionsWritten(row.metadata, new Date()),
			updatedAt: row.updatedAt,
		})
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.updatedAt, row.updatedAt),
			),
		);
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
			await markCaptionsWritten(source.id);
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
			externalUserId: string | null;
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
			externalUserId: developerVideos.externalUserId,
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
		externalUserId: video.externalUserId ?? null,
		sourceKey: developerVideoKeys(video, processing.encodeId, mp4.output).mp4,
		durationSeconds:
			typeof video.duration === "number" && video.duration > 0
				? video.duration
				: null,
	};
}
