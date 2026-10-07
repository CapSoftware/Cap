import { db } from "@cap/database";
import {
	loomImportJobItems,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { asc, eq, sql } from "drizzle-orm";
import { getLoomImportJobForUser } from "./jobs";
import {
	countLoomImportItems,
	deriveLoomImportItemState,
	type LoomImportItemView,
	type LoomImportSnapshot,
} from "./status";

const CURSOR_OVERLAP_MS = 3_000;

function time(value: Date | null | undefined) {
	return value ? value.getTime() : 0;
}

export async function getLoomImportSnapshot({
	jobId,
	userId,
	since,
}: {
	jobId: string;
	userId: User.UserId;
	since?: number;
}): Promise<LoomImportSnapshot | null> {
	const queriedAt = Date.now();
	const found = await getLoomImportJobForUser(jobId, userId);
	if (!found) return null;
	const { job, isAdmin } = found;

	const [[viewer], rows] = await Promise.all([
		db()
			.select({
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1),
		db()
			.select({
				id: loomImportJobItems.id,
				rowNumber: loomImportJobItems.rowNumber,
				loomUrl: loomImportJobItems.loomUrl,
				loomVideoId: loomImportJobItems.loomVideoId,
				ownerEmail: loomImportJobItems.ownerEmail,
				spaceName: loomImportJobItems.spaceName,
				status: loomImportJobItems.status,
				videoId: loomImportJobItems.videoId,
				title: loomImportJobItems.title,
				loomCreatedAt: loomImportJobItems.loomCreatedAt,
				durationSeconds: loomImportJobItems.durationSeconds,
				thumbnailUrl: loomImportJobItems.thumbnailUrl,
				error: loomImportJobItems.error,
				updatedAt: loomImportJobItems.updatedAt,
				videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
				videoUpdatedAt: videos.updatedAt,
				uploadPhase: videoUploads.phase,
				uploadProgress: videoUploads.processingProgress,
				uploadMessage: videoUploads.processingMessage,
				uploadError: videoUploads.processingError,
				uploadUpdatedAt: videoUploads.updatedAt,
			})
			.from(loomImportJobItems)
			.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
			.leftJoin(
				videoUploads,
				eq(videoUploads.videoId, loomImportJobItems.videoId),
			)
			.where(eq(loomImportJobItems.jobId, jobId))
			.orderBy(asc(loomImportJobItems.rowNumber)),
	]);

	const all: LoomImportItemView[] = rows.map((row) => {
		const state = deriveLoomImportItemState(
			{
				status: row.status,
				videoId: row.videoId,
				error: row.error,
				videoExists: Boolean(row.videoExists),
				uploadPhase: row.uploadPhase ?? null,
				uploadProgress: row.uploadProgress ?? null,
				uploadMessage: row.uploadMessage ?? null,
				uploadError: row.uploadError ?? null,
			},
			job.status,
		);
		return {
			id: row.id,
			row: row.rowNumber,
			url: row.loomUrl,
			loomId: row.loomVideoId,
			title: row.title,
			email: row.ownerEmail,
			space: row.spaceName,
			...state,
			videoId: row.videoId,
			recordedAt: row.loomCreatedAt?.toISOString() ?? null,
			duration: row.durationSeconds,
			thumb: row.thumbnailUrl,
			v: Math.max(
				time(row.updatedAt),
				time(row.videoUpdatedAt),
				time(row.uploadUpdatedAt),
			),
		};
	});

	let totalDuration = 0;
	let importedDuration = 0;
	const owners = new Set<string>();
	for (const item of all) {
		if (item.email) owners.add(item.email);
		if (
			item.duration &&
			item.status !== "failed" &&
			item.status !== "cancelled"
		) {
			totalDuration += item.duration;
			if (item.status === "imported") importedDuration += item.duration;
		}
	}

	const isPro = userIsPro(viewer ?? null);
	const createdByMe = job.createdById === userId;
	const full = since === undefined || !Number.isFinite(since);

	return {
		job: {
			id: job.id,
			fileName: job.fileName,
			status: job.status,
			totalCount: job.totalCount,
			createdAt: job.createdAt.toISOString(),
			startedAt: job.startedAt?.toISOString() ?? null,
			completedAt: job.completedAt?.toISOString() ?? null,
			createdByMe,
			canStart: createdByMe && isPro && job.status === "awaiting_upgrade",
			isPro,
			isAdmin,
		},
		counts: countLoomImportItems(all),
		totalDuration,
		importedDuration,
		owners: Math.max(owners.size, 1),
		items: full
			? all
			: all.filter((item) => item.v > (since as number) - CURSOR_OVERLAP_MS),
		cursor: queriedAt,
		full,
	};
}
