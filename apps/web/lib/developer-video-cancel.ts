import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { DEVELOPER_VIDEO_PARTS } from "./developer-video-state";
import { cancelMediaServerVideoJob } from "./media-client";

export function runningDeveloperVideoJobIds(
	processing: DeveloperVideoProcessingState | null,
): string[] {
	if (!processing) return [];
	return DEVELOPER_VIDEO_PARTS.flatMap((part) => {
		const current = processing[part];
		return current.state === "running" && current.jobId ? [current.jobId] : [];
	});
}

export async function cancelDeveloperVideoJobs(
	videoId: string,
	jobIds: readonly string[],
): Promise<void> {
	await Promise.all(
		jobIds.map(async (jobId) => {
			if ((await cancelMediaServerVideoJob(jobId)) === "failed") {
				console.warn("[developer-video] Could not cancel encode job", {
					videoId,
					jobId,
				});
			}
		}),
	);
}

const hasRunningPart = () =>
	or(
		sql`JSON_UNQUOTE(JSON_EXTRACT(${developerVideos.processing}, '$.hls.state')) = 'running'`,
		sql`JSON_UNQUOTE(JSON_EXTRACT(${developerVideos.processing}, '$.mp4.state')) = 'running'`,
	);

// Only videos already marked deleted are touched, and only inside the given
// app, so a caller cannot reach another app's jobs with a stray video id.
// Called once the delete has committed. Reading the jobs afterwards closes the
// gap with a dispatch that records its job id just before the delete: a job id
// recorded after it is refused by mutateEncode, and dispatch cancels that job
// itself. Webhooks from a cancelled job find the video deleted and are ignored.
export async function cancelDeveloperVideoEncodes(target: {
	appId: string;
	videoId?: string;
}): Promise<void> {
	try {
		const videos = await db()
			.select({
				id: developerVideos.id,
				processing: developerVideos.processing,
			})
			.from(developerVideos)
			.where(
				and(
					eq(developerVideos.appId, target.appId),
					target.videoId === undefined
						? hasRunningPart()
						: eq(developerVideos.id, target.videoId),
					isNotNull(developerVideos.deletedAt),
				),
			);
		await Promise.all(
			videos.map((video) =>
				cancelDeveloperVideoJobs(
					video.id,
					runningDeveloperVideoJobIds(video.processing),
				),
			),
		);
	} catch (error) {
		console.warn("[developer-video] Could not cancel encode jobs", {
			...target,
			error,
		});
	}
}
