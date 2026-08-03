import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { liveTranscribeWorkflow } from "@/workflows/live-transcribe";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export type LiveTranscriptionStart = "started" | "skipped";

/**
 * Kick off provisional live transcription for a just-created instant-mode
 * recording. Feature-flagged, idempotent (an atomic metadata claim allows
 * exactly one live workflow per video) and never throws: any failure means
 * the video simply behaves exactly as it does today.
 */
export async function maybeStartLiveTranscription({
	videoId,
	ownerId,
	orgId,
}: {
	videoId: Video.VideoId;
	ownerId: User.UserId;
	orgId: Organisation.OrganisationId;
}): Promise<LiveTranscriptionStart> {
	try {
		const env = serverEnv();
		if (!env.CAP_LIVE_TRANSCRIPTION || !env.ASSEMBLY_API_KEY) {
			return "skipped";
		}

		const [org] = await db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, orgId));
		if (org?.settings?.disableTranscript) {
			return "skipped";
		}

		const claim = await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript', JSON_OBJECT('status', 'active', 'updatedAt', ${new Date().toISOString()}))`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, videoId),
					eq(videos.ownerId, ownerId),
					sql`JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript') IS NULL`,
				),
			);

		if (getAffectedRows(claim) === 0) {
			return "skipped";
		}

		try {
			await start(liveTranscribeWorkflow, [{ videoId, userId: ownerId }]);
		} catch (error) {
			// Release the claim so a retried create can start the workflow.
			await db()
				.update(videos)
				.set({
					metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript')`,
					updatedAt: sql`${videos.updatedAt}`,
				})
				.where(eq(videos.id, videoId));
			throw error;
		}

		return "started";
	} catch (error) {
		console.warn(`[maybeStartLiveTranscription] Failed for ${videoId}`, error);
		return "skipped";
	}
}
