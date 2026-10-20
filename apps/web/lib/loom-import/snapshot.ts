import { db } from "@cap/database";
import {
	type LoomImportJobStatus,
	loomImportJobItems,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, asc, eq, gt, type SQL, sql } from "drizzle-orm";
import { hasProSubscription } from "@/lib/pro-subscription";
import {
	LOOM_IMPORT_JOB_STATUS_INDEX,
	LOOM_IMPORT_JOB_UPDATED_INDEX,
} from "./indexes";
import { getLoomImportJobForUser } from "./jobs";
import {
	deriveLoomImportItemState,
	type LoomImportItemView,
	type LoomImportSnapshot,
	summarizeLoomImportItems,
} from "./status";

export const LOOM_IMPORT_CURSOR_OVERLAP_MS = 3_000;

function time(value: Date | null | undefined) {
	return value ? value.getTime() : 0;
}

function selectItems(where: SQL | undefined, forceIndex?: string) {
	return db()
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
		.from(loomImportJobItems, forceIndex ? { forceIndex } : undefined)
		.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
		.leftJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(where)
		.orderBy(asc(loomImportJobItems.rowNumber));
}

type ItemRow = Awaited<ReturnType<typeof selectItems>>[number];

async function changedRows(jobId: string, after: Date) {
	const [changed, inFlight] = await Promise.all([
		selectItems(
			and(
				eq(loomImportJobItems.jobId, jobId),
				gt(loomImportJobItems.updatedAt, after),
			),
			LOOM_IMPORT_JOB_UPDATED_INDEX,
		),
		selectItems(
			and(
				eq(loomImportJobItems.jobId, jobId),
				eq(loomImportJobItems.status, "importing"),
			),
			LOOM_IMPORT_JOB_STATUS_INDEX,
		),
	]);
	const byId = new Map<string, ItemRow>();
	for (const row of [...changed, ...inFlight]) byId.set(row.id, row);
	return Array.from(byId.values()).sort(
		(left, right) => left.rowNumber - right.rowNumber,
	);
}

function toItemView(
	row: ItemRow,
	jobStatus: LoomImportJobStatus,
): LoomImportItemView {
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
		jobStatus,
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
	const full = since === undefined || !Number.isFinite(since);

	const [[viewer], rows] = await Promise.all([
		db()
			.select({
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1),
		full
			? selectItems(eq(loomImportJobItems.jobId, jobId))
			: changedRows(
					jobId,
					new Date((since as number) - LOOM_IMPORT_CURSOR_OVERLAP_MS),
				),
	]);

	const items = rows.map((row) => toItemView(row, job.status));
	const isPro = hasProSubscription(viewer ?? null);
	const createdByMe = job.createdById === userId;

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
		summary: full ? summarizeLoomImportItems(items) : null,
		items,
		cursor: queriedAt,
		full,
	};
}
