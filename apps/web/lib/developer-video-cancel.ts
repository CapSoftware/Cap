import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
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

export type DeveloperVideoCancelTarget =
	| { appId: string; videoId: string }
	| { appId: string; deletedAt: Date };

// deletedAt is a whole-second column and MySQL rounds on write, so the rows an
// app delete wrote are at or after the second it started in. Earlier deletes
// are left out: their parts stay running forever because callbacks for
// deleted videos are ignored, and their jobs were cancelled back then.
function deletedInSameSecondOrLater(deletedAt: Date) {
	return gte(
		developerVideos.deletedAt,
		new Date(Math.floor(deletedAt.getTime() / 1000) * 1000),
	);
}

// Only videos already marked deleted are touched, and only inside the given
// app, so a caller cannot reach another app's jobs with a stray video id.
// Called once the delete has committed. Reading the jobs afterwards closes the
// gap with a dispatch that records its job id just before the delete: a job id
// recorded after it is refused by mutateEncode, and dispatch cancels that job
// itself. Webhooks from a cancelled job find the video deleted and are ignored.
// Every cancel goes out at once so a hung media server costs one timeout.
export async function cancelDeveloperVideoEncodes(
	target: DeveloperVideoCancelTarget,
): Promise<void> {
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
					"videoId" in target
						? eq(developerVideos.id, target.videoId)
						: and(
								deletedInSameSecondOrLater(target.deletedAt),
								hasRunningPart(),
							),
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
