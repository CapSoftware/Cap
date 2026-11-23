import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { mediaProcessingBudgets } from "@cap/database/schema";
import { asc, inArray, sql } from "drizzle-orm";

export const MAX_MEDIA_OBJECTS_PER_VIDEO = 400;
export const MAX_MEDIA_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MEDIA_BYTES_PER_VIEWER = 10 * 1024 * 1024 * 1024;

// Matches the comment media upload token lifetime. A reservation counts in its
// own window and the two after it, so it outlives its token by at least one
// full window. That margin covers the bucket listing taken before the
// reservation and the token minted after it falling on either side of a window
// boundary.
export const COMMENT_MEDIA_RESERVATION_WINDOW_MS = 6 * 60 * 60 * 1000;
const COUNTED_WINDOWS = 3;

const reservationKey = (scope: readonly string[], windowIndex: number) =>
	createHash("sha256")
		.update(JSON.stringify([...scope, windowIndex]))
		.digest("hex");

async function reserveInWindows(input: {
	scope: readonly string[];
	amount: number;
	alreadyUsed: number;
	limit: number;
	now?: Date;
}) {
	const now = (input.now ?? new Date()).getTime();
	const windowIndex = Math.floor(now / COMMENT_MEDIA_RESERVATION_WINDOW_MS);
	const currentKey = reservationKey(input.scope, windowIndex);
	const windows = Array.from({ length: COUNTED_WINDOWS }, (_, age) => ({
		id: reservationKey(input.scope, windowIndex - age),
		index: windowIndex - age,
	})).sort((left, right) => left.id.localeCompare(right.id));

	return db().transaction(async (tx) => {
		await tx
			.insert(mediaProcessingBudgets)
			.values(
				windows.map((window) => ({
					id: window.id,
					limitBytes: input.limit,
					expiresAt: new Date(
						(window.index + COUNTED_WINDOWS) *
							COMMENT_MEDIA_RESERVATION_WINDOW_MS,
					),
				})),
			)
			.onDuplicateKeyUpdate({
				set: { id: sql`${mediaProcessingBudgets.id}` },
			});
		const locked = await tx
			.select()
			.from(mediaProcessingBudgets)
			.where(
				inArray(
					mediaProcessingBudgets.id,
					windows.map((window) => window.id),
				),
			)
			.orderBy(asc(mediaProcessingBudgets.id))
			.for("update");
		if (locked.length !== windows.length)
			throw new Error("Comment media quota is unavailable");

		const reserved = locked.reduce((sum, row) => sum + row.reservedBytes, 0);
		if (input.alreadyUsed + reserved + input.amount > input.limit) return false;

		await tx
			.update(mediaProcessingBudgets)
			.set({
				reservedBytes: sql`${mediaProcessingBudgets.reservedBytes} + ${input.amount}`,
			})
			.where(inArray(mediaProcessingBudgets.id, [currentKey]));
		return true;
	});
}

export function reserveCommentMediaObjects(input: {
	videoId: string;
	objects: number;
	storedObjects: number;
	now?: Date;
}) {
	return reserveInWindows({
		scope: ["comment-media", input.videoId],
		amount: input.objects,
		alreadyUsed: input.storedObjects,
		limit: MAX_MEDIA_OBJECTS_PER_VIDEO,
		now: input.now,
	});
}

export function reserveCommentMediaBytes(input: {
	videoId: string;
	userId: string;
	bytes: number;
	now?: Date;
}) {
	return reserveInWindows({
		scope: ["comment-media-bytes", input.videoId, input.userId],
		amount: input.bytes,
		alreadyUsed: 0,
		limit: MAX_MEDIA_BYTES_PER_VIEWER,
		now: input.now,
	});
}
