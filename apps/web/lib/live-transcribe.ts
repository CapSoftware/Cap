import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import {
	type FarmLiveStart,
	rotateLiveSession,
	startFarmLiveTranscription,
	WORKFLOW_LIVE_SESSION,
} from "@/lib/live-transcribe-farm";
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
 * recording. Idempotent (an atomic metadata claim allows exactly one live
 * workflow per video) and never throws: any failure means the video simply
 * behaves exactly as it does today.
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
		if (!serverEnv().ASSEMBLY_API_KEY) {
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
			await dispatchLiveTranscription(videoId, ownerId, null);
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

/**
 * Run an active live transcription on the media server when that's enabled
 * and a server takes it, otherwise on the workflow, which resumes from the
 * artifact. `from` is the claim's current session (null before the first).
 */
export async function dispatchLiveTranscription(
	videoId: Video.VideoId,
	ownerId: User.UserId,
	from: string | null,
): Promise<"media-server" | "workflow" | "lost"> {
	let farm: FarmLiveStart;
	try {
		farm = await startFarmLiveTranscription(videoId, from);
	} catch (error) {
		console.warn(
			`[dispatchLiveTranscription] Media server path failed for ${videoId}`,
			error,
		);
		farm = { status: "declined", session: from };
	}
	if (farm.status === "started") return "media-server";
	if (farm.status === "lost") return "lost";
	if (
		farm.session !== null &&
		!(await rotateLiveSession(videoId, farm.session, WORKFLOW_LIVE_SESSION))
	) {
		return "lost";
	}

	try {
		await start(liveTranscribeWorkflow, [{ videoId, userId: ownerId }]);
	} catch (error) {
		// Hand the claim back so a retried release can try again; a first start
		// has no session to return to and its caller drops the claim instead.
		if (from !== null) {
			await rotateLiveSession(videoId, WORKFLOW_LIVE_SESSION, from).catch(
				() => false,
			);
		}
		throw error;
	}
	return "workflow";
}
