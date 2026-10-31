import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export const MEDIA_INPUT_POLICY_ERROR_CODE = "input-policy-violation";
export const MEDIA_INPUT_REJECTED_ERROR_PREFIX = "media-input-rejected";
export const MEDIA_PROCESSING_SUSPENDED_ERROR_PREFIX =
	"media-processing-suspended";
export const MEDIA_INPUT_POLICY_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MEDIA_INPUT_POLICY_STRIKE_THRESHOLD = 3;
const MAX_STORED_STRIKES = 10;

const PROCESSABLE_MEDIA_EXTENSIONS = new Set([
	"mp4",
	"m4v",
	"mov",
	"webm",
	"mkv",
	"avi",
	"flv",
	"ts",
	"mts",
	"m2ts",
	"mpg",
	"mpeg",
	"wmv",
	"3gp",
	"ogv",
]);

const NON_MEDIA_UPLOAD_EXTENSIONS = new Set([
	"m3u8",
	"m3u",
	"mpd",
	"txt",
	"ffconcat",
	"xml",
]);

export const unsupportedMediaInputError = `${MEDIA_INPUT_REJECTED_ERROR_PREFIX}: the uploaded file is not a supported video file`;
export const mediaProcessingSuspendedError = `${MEDIA_PROCESSING_SUSPENDED_ERROR_PREFIX}: media processing is unavailable for this account`;
export const nonMediaUploadMessage = "This file type cannot be uploaded";

export function getStorageKeyExtension(key: string): string | null {
	const fileName = key.split("/").at(-1) ?? "";
	const dot = fileName.lastIndexOf(".");
	if (dot === -1 || dot === fileName.length - 1) return null;
	return fileName.slice(dot + 1).toLowerCase();
}

export function isProcessableMediaKey(key: string): boolean {
	const extension = getStorageKeyExtension(key);
	return extension !== null && PROCESSABLE_MEDIA_EXTENSIONS.has(extension);
}

// Raw sources live directly under `<owner>/<video>/` (raw-upload.*, result.mp4,
// agent uploads) or under `source/` (edit sources). Legacy segmented recordings
// upload playlists under nested folders such as `output/` and
// `combined-source/`, so only these source locations are restricted.
export function isNonMediaRawUploadKey(fileKey: string): boolean {
	const subpath = fileKey.split("/").slice(2).join("/");
	if (!subpath) return false;
	const isSourceLocation =
		!subpath.includes("/") || subpath.startsWith("source/");
	if (!isSourceLocation) return false;
	const extension = getStorageKeyExtension(subpath);
	return extension !== null && NON_MEDIA_UPLOAD_EXTENSIONS.has(extension);
}

export function isMediaPolicyProcessingError(
	error: string | null | undefined,
): error is string {
	return Boolean(
		error &&
			(error.includes(`${MEDIA_INPUT_REJECTED_ERROR_PREFIX}:`) ||
				error.includes(`${MEDIA_PROCESSING_SUSPENDED_ERROR_PREFIX}:`)),
	);
}

export type MediaInputPolicyStrike = { at: number; videoId: string };

export type MediaInputPolicyState = {
	strikes: MediaInputPolicyStrike[];
	suspendedAt?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function readMediaInputPolicyState(
	preferences: unknown,
): MediaInputPolicyState {
	const value = isRecord(preferences)
		? preferences.mediaInputPolicy
		: undefined;
	if (!isRecord(value)) return { strikes: [] };
	const strikes = Array.isArray(value.strikes)
		? value.strikes.flatMap((strike): MediaInputPolicyStrike[] =>
				isRecord(strike) &&
				typeof strike.at === "number" &&
				Number.isFinite(strike.at) &&
				typeof strike.videoId === "string"
					? [{ at: strike.at, videoId: strike.videoId }]
					: [],
			)
		: [];
	return typeof value.suspendedAt === "string"
		? { strikes, suspendedAt: value.suspendedAt }
		: { strikes };
}

export function applyMediaInputPolicyStrike(
	state: MediaInputPolicyState,
	strike: MediaInputPolicyStrike,
): {
	state: MediaInputPolicyState;
	recorded: boolean;
	newlySuspended: boolean;
} {
	const windowStart = strike.at - MEDIA_INPUT_POLICY_STRIKE_WINDOW_MS;
	const recent = state.strikes.filter((entry) => entry.at > windowStart);
	const recorded = !recent.some((entry) => entry.videoId === strike.videoId);
	const strikes = (recorded ? [...recent, strike] : recent).slice(
		-MAX_STORED_STRIKES,
	);
	const newlySuspended =
		!state.suspendedAt && strikes.length >= MEDIA_INPUT_POLICY_STRIKE_THRESHOLD;
	const suspendedAt =
		state.suspendedAt ??
		(newlySuspended ? new Date(strike.at).toISOString() : undefined);
	return {
		state: suspendedAt ? { strikes, suspendedAt } : { strikes },
		recorded,
		newlySuspended,
	};
}

export async function isMediaProcessingSuspended(
	userId: User.UserId,
): Promise<boolean> {
	const [user] = await db()
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return readMediaInputPolicyState(user?.preferences).suspendedAt !== undefined;
}

export async function getMediaProcessingRejection(input: {
	ownerId: User.UserId;
	rawFileKey?: string | null;
}): Promise<string | null> {
	if (
		input.rawFileKey !== undefined &&
		input.rawFileKey !== null &&
		!isProcessableMediaKey(input.rawFileKey)
	) {
		return unsupportedMediaInputError;
	}
	if (await isMediaProcessingSuspended(input.ownerId)) {
		return mediaProcessingSuspendedError;
	}
	return null;
}
