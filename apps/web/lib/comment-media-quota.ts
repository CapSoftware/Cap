import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { mediaProcessingBudgets } from "@cap/database/schema";
import { asc, inArray, sql } from "drizzle-orm";

export const MAX_MEDIA_OBJECTS_PER_VIDEO = 400;

// Matches the comment media upload token lifetime. A reservation counts in its
// own window and the two after it, so it outlives its token by at least one
// full window. That margin covers the bucket listing taken before the
// reservation and the token minted after it falling on either side of a window
// boundary.
export const COMMENT_MEDIA_RESERVATION_WINDOW_MS = 6 * 60 * 60 * 1000;
const COUNTED_WINDOWS = 3;

const reservationKey = (videoId: string, windowIndex: number) =>
	createHash("sha256")
		.update(JSON.stringify(["comment-media", videoId, windowIndex]))
		.digest("hex");

export async function reserveCommentMediaObjects(input: {
	videoId: string;
	objects: number;
	storedObjects: number;
	now?: Date;
}) {
	const now = (input.now ?? new Date()).getTime();
	const windowIndex = Math.floor(now / COMMENT_MEDIA_RESERVATION_WINDOW_MS);
	const currentKey = reservationKey(input.videoId, windowIndex);
	const windows = Array.from({ length: COUNTED_WINDOWS }, (_, age) => ({
		id: reservationKey(input.videoId, windowIndex - age),
		index: windowIndex - age,
	})).sort((left, right) => left.id.localeCompare(right.id));

	return db().transaction(async (tx) => {
		await tx
			.insert(mediaProcessingBudgets)
			.values(
				windows.map((window) => ({
					id: window.id,
					limitBytes: MAX_MEDIA_OBJECTS_PER_VIDEO,
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
		if (
			input.storedObjects + reserved + input.objects >
			MAX_MEDIA_OBJECTS_PER_VIDEO
		)
			return false;

		await tx
			.update(mediaProcessingBudgets)
			.set({
				reservedBytes: sql`${mediaProcessingBudgets.reservedBytes} + ${input.objects}`,
			})
			.where(inArray(mediaProcessingBudgets.id, [currentKey]));
		return true;
	});
}
