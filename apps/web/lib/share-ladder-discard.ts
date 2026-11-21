import { db } from "@cap/database";
import { shareLadders } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { cancelMediaServerVideoJob } from "@/lib/media-client";
import {
	deleteShareObjectsUnder,
	purgeShareLadderCdn,
} from "@/lib/share-ladder-storage";

export function shareLadderVideoPrefix(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/.recording/outputs/ladder-`;
}

export async function discardShareLadder(
	videoId: Video.VideoId,
	reason: string,
): Promise<void> {
	const [row] = await db()
		.select({
			ownerId: shareLadders.ownerId,
			jobId: shareLadders.jobId,
			state: shareLadders.state,
			outputPrefix: shareLadders.outputPrefix,
		})
		.from(shareLadders)
		.where(eq(shareLadders.videoId, videoId))
		.limit(1);
	if (!row) return;
	await db()
		.update(shareLadders)
		.set({ state: "invalid", error: reason, updatedAt: new Date() })
		.where(eq(shareLadders.videoId, videoId));
	if (row.jobId && (row.state === "encoding" || row.state === "queued")) {
		await cancelMediaServerVideoJob(row.jobId).catch(() => "failed");
	}
	await deleteShareObjectsUnder(shareLadderVideoPrefix(row.ownerId, videoId));
	if (row.state === "ready" && row.outputPrefix) {
		await purgeShareLadderCdn(row.outputPrefix).catch((error) => {
			console.error("[share-ladder] CDN purge failed", { videoId, error });
		});
	}
	await db().delete(shareLadders).where(eq(shareLadders.videoId, videoId));
}

export async function discardShareLadderSafely(
	videoId: Video.VideoId,
	reason: string,
): Promise<void> {
	try {
		await discardShareLadder(videoId, reason);
	} catch (error) {
		console.error("[share-ladder] Failed to discard ladder", {
			videoId,
			reason,
			error,
		});
		try {
			await db()
				.update(shareLadders)
				.set({ state: "invalid", error: reason, updatedAt: new Date() })
				.where(eq(shareLadders.videoId, videoId));
		} catch (markError) {
			console.error("[share-ladder] Failed to mark ladder invalid", {
				videoId,
				markError,
			});
		}
	}
}
