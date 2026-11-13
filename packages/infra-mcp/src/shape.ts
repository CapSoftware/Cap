import { isCreditCode } from "./errors";
import { asRecord } from "./http";
import { withoutQuery } from "./redact";

type Fields = Record<string, unknown>;

function pick(source: Fields, names: readonly string[]): Fields {
	const picked: Fields = {};
	for (const name of names) {
		if (source[name] !== undefined) picked[name] = source[name];
	}
	return picked;
}

const VIDEO_LINKS = [
	"playbackId",
	"hlsUrl",
	"mp4Url",
	"posterUrl",
	"shareUrl",
	"embedUrl",
] as const;

export const videoLinks = (video: Fields) => pick(video, VIDEO_LINKS);

export const videoRow = (video: Fields) => ({
	...pick(video, ["id", "name", "status", "duration"]),
	userId: video.externalUserId ?? null,
	...pick(video, ["createdAt", "shareUrl"]),
});

export const videoDetail = (video: Fields) => ({
	...pick(video, [
		"id",
		"name",
		"status",
		"errorReason",
		"duration",
		"width",
		"height",
	]),
	userId: video.externalUserId ?? null,
	...pick(video, ["maxResolutionTier", "metadata", "createdAt"]),
	...videoLinks(video),
	...pick(video, ["captions"]),
});

export function transcriptView(
	transcript: Fields,
	consoleUrl: string,
	options: { text?: boolean } = {},
) {
	const source = asRecord(transcript.source);
	const error = transcript.error === null ? null : asRecord(transcript.error);
	return {
		...pick(transcript, ["id", "status", "name"]),
		source: { type: source.type ?? null, url: withoutQuery(source.url) },
		...pick(transcript, [
			"videoId",
			"durationSeconds",
			"language",
			"wordCount",
			"costDollars",
		]),
		error: error === null ? null : pick(error, ["code", "message"]),
		...(error !== null && isCreditCode(error.code)
			? { addCreditAt: consoleUrl }
			: {}),
		...pick(transcript, ["userId", "metadata", "createdAt", "completedAt"]),
		...(options.text ? pick(transcript, ["text"]) : {}),
	};
}

export const CAPTIONS_NEXT =
	"This transcript came from a stored video, so its captions are added to that video's player, share page and embed, usually within a few seconds of completing. videos_get lists each one under captions, with the url of its WebVTT file, once that file is written.";

export const captionsNext = (transcript: Fields) =>
	transcript.status === "complete" &&
	typeof transcript.videoId === "string" &&
	typeof transcript.wordCount === "number" &&
	transcript.wordCount > 0
		? { next: CAPTIONS_NEXT }
		: {};

export const transactionRow = (row: Fields) =>
	pick(row, [
		"id",
		"type",
		"description",
		"note",
		"amountDollars",
		"balanceAfterDollars",
		"referenceType",
		"referenceId",
		"createdAt",
	]);

export function page(
	reply: unknown,
	limit: number,
	offset: number,
	returned: number,
) {
	const pagination = asRecord(asRecord(reply).pagination);
	const hasMore =
		typeof pagination.hasMore === "boolean"
			? pagination.hasMore
			: returned >= limit;
	return { limit, offset, nextOffset: hasMore ? offset + returned : null };
}
