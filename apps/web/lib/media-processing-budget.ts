import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { mediaProcessingBudgets } from "@cap/database/schema";
import { asc, inArray, lt, sql } from "drizzle-orm";

const MiB = 1024 ** 2;
export class MediaProcessingBudgetError extends Error {
	constructor(readonly scope: "recording") {
		super(`Recording processing paused: ${scope} transfer budget exhausted`);
		this.name = "MediaProcessingBudgetError";
	}
}
const key = (parts: string[]) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function getMediaProcessingReservation(sourceBytes: number) {
	if (
		!Number.isSafeInteger(sourceBytes) ||
		sourceBytes <= 0 ||
		sourceBytes > Number.MAX_SAFE_INTEGER / 12
	)
		throw new Error("Invalid processing source size");
	return {
		attemptBytes: sourceBytes * 3 + 16 * MiB,
		recordingBytes: sourceBytes * 9 + 80 * MiB,
	};
}

export async function reserveMediaProcessingBudget(input: {
	videoId: string;
	generation: string;
	attemptId: string;
	sourceBytes: number;
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const { attemptBytes, recordingBytes } = getMediaProcessingReservation(
		input.sourceBytes,
	);
	const attemptKey = key([
		"attempt",
		input.videoId,
		input.generation,
		input.attemptId,
	]);
	const recordingKey = key(["recording", input.videoId, input.generation]);
	const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
	return db().transaction(async (tx) => {
		const limits = [
			{ id: attemptKey, limitBytes: attemptBytes },
			{ id: recordingKey, limitBytes: recordingBytes },
		].sort((left, right) => left.id.localeCompare(right.id));
		await tx
			.insert(mediaProcessingBudgets)
			.values(limits.map((limit) => ({ ...limit, expiresAt })))
			.onDuplicateKeyUpdate({
				set: {
					id: sql`${mediaProcessingBudgets.id}`,
					expiresAt: sql`GREATEST(${mediaProcessingBudgets.expiresAt}, ${expiresAt})`,
				},
			});
		const locked = await tx
			.select()
			.from(mediaProcessingBudgets)
			.where(
				inArray(
					mediaProcessingBudgets.id,
					limits.map((limit) => limit.id),
				),
			)
			.orderBy(asc(mediaProcessingBudgets.id))
			.for("update");
		const rows = new Map(locked.map((row) => [row.id, row]));
		if (rows.size !== limits.length)
			throw new Error("Processing budget is unavailable");

		const attempt = rows.get(attemptKey);
		if (attempt?.reservedBytes) {
			if (attempt.reservedBytes !== attemptBytes)
				throw new Error("Processing reservation changed");
			return attemptBytes;
		}
		for (const [id, scope] of [[recordingKey, "recording"]] as const) {
			const row = rows.get(id);
			if (!row || row.reservedBytes + attemptBytes > row.limitBytes)
				throw new MediaProcessingBudgetError(scope);
		}
		await tx
			.update(mediaProcessingBudgets)
			.set({
				reservedBytes: sql`${mediaProcessingBudgets.reservedBytes} + ${attemptBytes}`,
			})
			.where(
				inArray(
					mediaProcessingBudgets.id,
					limits.map((limit) => limit.id),
				),
			);

		return attemptBytes;
	});
}

export async function cleanupExpiredMediaProcessingBudgets(now = new Date()) {
	const result = await db()
		.delete(mediaProcessingBudgets)
		.where(lt(mediaProcessingBudgets.expiresAt, now))
		.limit(1_000);
	return result[0].affectedRows;
}
