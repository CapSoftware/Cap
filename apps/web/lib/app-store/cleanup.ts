import { db } from "@cap/database";
import { appStoreEvents } from "@cap/database/schema";
import { lt } from "drizzle-orm";

// Event rows only stop the same event reaching an app twice. cap.ready fires
// for at most a week after a Cap is made and retries finish within hours, so
// a month of rows covers every repeat that matters.
export const APP_STORE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const affectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number }).affectedRows ?? 0);

export async function cleanupAppStoreEvents(input?: {
	now?: Date;
	batchSize?: number;
	maxBatches?: number;
}) {
	const now = input?.now ?? new Date();
	const batchSize = Math.min(Math.max(input?.batchSize ?? 5_000, 1), 5_000);
	const maxBatches = Math.min(Math.max(input?.maxBatches ?? 20, 1), 50);
	const cutoff = new Date(now.getTime() - APP_STORE_EVENT_RETENTION_MS);
	let deleted = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const count = affectedRows(
			await db()
				.delete(appStoreEvents)
				.where(lt(appStoreEvents.createdAt, cutoff))
				.limit(batchSize),
		);
		deleted += count;
		if (count < batchSize) break;
	}
	return deleted;
}
