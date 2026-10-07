import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	loomImportJobItems,
	loomImportJobs,
	spaceVideos,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { getNewVideoPublic } from "@cap/database/video-sharing-default";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { type Organisation, type User, Video } from "@cap/web-domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Option } from "effect";
import { start } from "workflow/api";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";
import { settleLoomImportItem } from "./status";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const WAITING_FOR_CAPACITY = "Queued for Loom import";

type VideoInsert = typeof videos.$inferInsert;

type Writable = {
	bucketId: NonNullable<VideoInsert["bucket"]> | null;
	storageIntegrationId: NonNullable<VideoInsert["storageIntegrationId"]> | null;
};

type Launch = {
	itemId: string;
	videoId: Video.VideoId;
	ownerId: User.UserId;
	rawFileKey: string;
	bucketId: string | null;
	loomVideoId: string;
	reuseExistingRawUpload: boolean;
};

export function loomImportConcurrency() {
	const configured = Number.parseInt(
		serverEnv().LOOM_IMPORT_CONCURRENCY ?? "",
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? Math.min(configured, MAX_CONCURRENCY)
		: DEFAULT_CONCURRENCY;
}

function isDuplicateKeyError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		if (
			typeof current === "object" &&
			("code" in current || "errno" in current) &&
			((current as { code?: unknown }).code === "ER_DUP_ENTRY" ||
				(current as { errno?: unknown }).errno === 1062)
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

export function rawFileKeyFor(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/raw-upload.mp4`;
}

async function writableFor(
	cache: Map<string, Writable | null>,
	ownerId: User.UserId,
	orgId: Organisation.OrganisationId,
) {
	if (cache.has(ownerId)) return cache.get(ownerId) ?? null;
	const writable = await Storage.getWritableAccessForUser(ownerId, orgId)
		.pipe(runWorkflowPromise)
		.then(
			(value) => ({
				bucketId: Option.getOrNull(value.bucketId),
				storageIntegrationId: Option.getOrNull(value.storageIntegrationId),
			}),
			(error) => {
				console.error("[loom-import] Could not resolve storage", {
					ownerId,
					orgId,
					error,
				});
				return null;
			},
		);
	cache.set(ownerId, writable);
	return writable;
}

export async function dispatchLoomImportJob(jobId: string) {
	const [job] = await db()
		.select({ orgId: loomImportJobs.orgId, status: loomImportJobs.status })
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId))
		.limit(1);
	if (!job || job.status !== "importing") {
		return { started: 0, completed: job?.status === "completed" };
	}

	const limit = loomImportConcurrency();
	const isPublic = await getNewVideoPublic(job.orgId);
	const storage = new Map<string, Writable | null>();
	const upcoming = await db()
		.select({ ownerId: loomImportJobItems.ownerId })
		.from(loomImportJobItems)
		.where(
			and(
				eq(loomImportJobItems.jobId, jobId),
				eq(loomImportJobItems.status, "ready"),
			),
		)
		.orderBy(asc(loomImportJobItems.rowNumber))
		.limit(limit * 2);
	for (const ownerId of new Set(upcoming.map((row) => row.ownerId))) {
		if (ownerId) await writableFor(storage, ownerId, job.orgId);
	}

	const outcome = await db().transaction(async (tx) => {
		const [locked] = await tx
			.select({ status: loomImportJobs.status })
			.from(loomImportJobs)
			.where(eq(loomImportJobs.id, jobId))
			.for("update");
		if (!locked || locked.status !== "importing") {
			return { launches: [] as Launch[], completed: false };
		}

		const inFlight = await tx
			.select({
				id: loomImportJobItems.id,
				videoId: loomImportJobItems.videoId,
				videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
				uploadVideoId: videoUploads.videoId,
				uploadPhase: videoUploads.phase,
				uploadMessage: videoUploads.processingMessage,
				uploadError: videoUploads.processingError,
			})
			.from(loomImportJobItems)
			.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
			.leftJoin(
				videoUploads,
				eq(videoUploads.videoId, loomImportJobItems.videoId),
			)
			.where(
				and(
					eq(loomImportJobItems.jobId, jobId),
					eq(loomImportJobItems.status, "importing"),
				),
			);

		const now = new Date();
		const completedIds: string[] = [];
		const failures = new Map<string, string[]>();
		let active = 0;
		let waiting = 0;
		for (const row of inFlight) {
			const settled = settleLoomImportItem({
				status: "importing",
				videoExists: Boolean(row.videoId && row.videoExists),
				uploadPhase: row.uploadVideoId ? row.uploadPhase : null,
				uploadError: row.uploadError,
			});
			if (settled?.status === "complete") {
				completedIds.push(row.id);
			} else if (settled) {
				failures.set(settled.error, [
					...(failures.get(settled.error) ?? []),
					row.id,
				]);
			} else {
				active++;
				if (row.uploadMessage?.startsWith(WAITING_FOR_CAPACITY)) waiting++;
			}
		}

		if (completedIds.length > 0) {
			await tx
				.update(loomImportJobItems)
				.set({ status: "complete", error: null, updatedAt: now })
				.where(inArray(loomImportJobItems.id, completedIds));
		}
		for (const [error, ids] of failures) {
			await tx
				.update(loomImportJobItems)
				.set({ status: "failed", error, updatedAt: now })
				.where(inArray(loomImportJobItems.id, ids));
		}

		const launches: Launch[] = [];
		while (waiting === 0 && active + launches.length < limit) {
			const claimed = await tx
				.select({
					id: loomImportJobItems.id,
					ownerId: loomImportJobItems.ownerId,
					spaceId: loomImportJobItems.spaceId,
					videoId: loomImportJobItems.videoId,
					loomVideoId: loomImportJobItems.loomVideoId,
					title: loomImportJobItems.title,
					loomCreatedAt: loomImportJobItems.loomCreatedAt,
					durationSeconds: loomImportJobItems.durationSeconds,
					width: loomImportJobItems.width,
					height: loomImportJobItems.height,
				})
				.from(loomImportJobItems)
				.where(
					and(
						eq(loomImportJobItems.jobId, jobId),
						eq(loomImportJobItems.status, "ready"),
					),
				)
				.orderBy(asc(loomImportJobItems.rowNumber))
				.limit(limit - active - launches.length)
				.for("update");
			if (claimed.length === 0) break;

			for (const item of claimed) {
				if (!item.ownerId || !item.loomVideoId) {
					await tx
						.update(loomImportJobItems)
						.set({
							status: "failed",
							error: "We couldn't find an owner for this video.",
							updatedAt: now,
						})
						.where(eq(loomImportJobItems.id, item.id));
					continue;
				}

				if (item.videoId) {
					const [existing] = await tx
						.select({
							id: videos.id,
							bucket: videos.bucket,
							ownerId: videos.ownerId,
						})
						.from(videos)
						.where(eq(videos.id, item.videoId))
						.limit(1);
					if (existing) {
						const rawFileKey = rawFileKeyFor(existing.ownerId, existing.id);
						await tx
							.insert(videoUploads)
							.values({
								videoId: existing.id,
								phase: "uploading",
								processingProgress: 0,
								processingMessage: "Retrying Loom import...",
								rawFileKey,
							})
							.onDuplicateKeyUpdate({
								set: {
									phase: "uploading",
									processingProgress: 0,
									processingMessage: "Retrying Loom import...",
									processingError: null,
									rawFileKey,
									updatedAt: now,
								},
							});
						await tx
							.update(loomImportJobItems)
							.set({ status: "importing", error: null, updatedAt: now })
							.where(eq(loomImportJobItems.id, item.id));
						launches.push({
							itemId: item.id,
							videoId: existing.id,
							ownerId: existing.ownerId,
							rawFileKey,
							bucketId: existing.bucket,
							loomVideoId: item.loomVideoId,
							reuseExistingRawUpload: true,
						});
						continue;
					}
				}

				const writable = await writableFor(storage, item.ownerId, job.orgId);
				if (!writable) {
					await tx
						.update(loomImportJobItems)
						.set({
							status: "failed",
							error: "We couldn't prepare storage for this video.",
							updatedAt: now,
						})
						.where(eq(loomImportJobItems.id, item.id));
					continue;
				}

				const videoId = Video.VideoId.make(nanoId());
				const ownerId = item.ownerId;
				const loomVideoId = item.loomVideoId;
				const rawFileKey = rawFileKeyFor(ownerId, videoId);
				const fallbackName = `Loom Import - ${now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;
				try {
					await tx.transaction(async (savepoint) => {
						await savepoint.insert(videos).values({
							id: videoId,
							name: item.title || fallbackName,
							ownerId,
							orgId: job.orgId,
							source: { type: "webMP4" as const },
							bucket: writable.bucketId,
							storageIntegrationId: writable.storageIntegrationId,
							public: isPublic,
							...(item.durationSeconds
								? { duration: item.durationSeconds }
								: {}),
							...(item.width ? { width: item.width } : {}),
							...(item.height ? { height: item.height } : {}),
							...(item.loomCreatedAt
								? {
										metadata: {
											customCreatedAt: item.loomCreatedAt.toISOString(),
										},
									}
								: {}),
						});
						await savepoint.insert(videoUploads).values({
							videoId,
							phase: "uploading",
							processingProgress: 0,
							processingMessage: "Importing from Loom...",
							rawFileKey,
						});
						await savepoint.insert(importedVideos).values({
							id: videoId,
							orgId: job.orgId,
							source: "loom",
							sourceId: loomVideoId,
						});
						if (item.spaceId) {
							await savepoint.insert(spaceVideos).values({
								id: nanoId(),
								spaceId: item.spaceId,
								videoId,
								addedById: ownerId,
							});
						}
						await savepoint
							.update(loomImportJobItems)
							.set({
								status: "importing",
								videoId,
								error: null,
								updatedAt: now,
							})
							.where(eq(loomImportJobItems.id, item.id));
					});
				} catch (error) {
					if (!isDuplicateKeyError(error)) throw error;
					const [existing] = await tx
						.select({ id: importedVideos.id })
						.from(importedVideos)
						.where(
							and(
								eq(importedVideos.orgId, job.orgId),
								eq(importedVideos.source, "loom"),
								eq(importedVideos.sourceId, loomVideoId),
							),
						)
						.limit(1);
					await tx
						.update(loomImportJobItems)
						.set({
							status: "skipped",
							videoId: existing ? Video.VideoId.make(existing.id) : null,
							error: "Already in Cap.",
							updatedAt: now,
						})
						.where(eq(loomImportJobItems.id, item.id));
					continue;
				}

				launches.push({
					itemId: item.id,
					videoId,
					ownerId,
					rawFileKey,
					bucketId: writable.bucketId,
					loomVideoId,
					reuseExistingRawUpload: false,
				});
			}
		}

		let completed = false;
		if (active + launches.length === 0) {
			const [open] = await tx
				.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
				.from(loomImportJobItems)
				.where(
					and(
						eq(loomImportJobItems.jobId, jobId),
						inArray(loomImportJobItems.status, [
							"pending",
							"ready",
							"importing",
						]),
					),
				);
			completed = (open?.count ?? 0) === 0;
		}

		await tx
			.update(loomImportJobs)
			.set(
				completed
					? { status: "completed", completedAt: now, updatedAt: now }
					: { updatedAt: now },
			)
			.where(eq(loomImportJobs.id, jobId));

		return { launches, completed };
	});

	for (const launch of outcome.launches) {
		try {
			await start(importLoomVideoWorkflow, [
				{
					videoId: launch.videoId,
					userId: launch.ownerId,
					rawFileKey: launch.rawFileKey,
					bucketId: launch.bucketId,
					loomVideoId: launch.loomVideoId,
					...(launch.reuseExistingRawUpload
						? { reuseExistingRawUpload: true }
						: {}),
				},
			]);
		} catch (error) {
			console.error("[loom-import] Could not start import workflow", {
				videoId: launch.videoId,
				error,
			});
			const now = new Date();
			await db()
				.update(videoUploads)
				.set({
					phase: "error",
					processingError: "Loom import could not start.",
					processingMessage: "Loom import failed",
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, launch.videoId));
			await db()
				.update(loomImportJobItems)
				.set({
					status: "failed",
					error: "Loom import could not start.",
					updatedAt: now,
				})
				.where(eq(loomImportJobItems.id, launch.itemId));
		}
	}

	return { started: outcome.launches.length, completed: outcome.completed };
}

export async function dispatchLoomImportForVideo(videoId: string) {
	const items = await db()
		.select({
			id: loomImportJobItems.id,
			jobId: loomImportJobItems.jobId,
			status: loomImportJobItems.status,
			error: loomImportJobItems.error,
			jobStatus: loomImportJobs.status,
			videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
			uploadVideoId: videoUploads.videoId,
			uploadPhase: videoUploads.phase,
			uploadError: videoUploads.processingError,
		})
		.from(loomImportJobItems)
		.innerJoin(loomImportJobs, eq(loomImportJobs.id, loomImportJobItems.jobId))
		.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
		.leftJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(
			and(
				eq(loomImportJobItems.videoId, Video.VideoId.make(videoId)),
				inArray(loomImportJobItems.status, ["importing", "failed", "complete"]),
			),
		);
	if (items.length === 0) return null;

	const jobsToDispatch = new Set<string>();
	for (const item of items) {
		if (item.jobStatus === "importing" && item.status === "importing") {
			jobsToDispatch.add(item.jobId);
			continue;
		}
		const settled = settleLoomImportItem({
			status: item.status,
			videoExists: Boolean(item.videoExists),
			uploadPhase: item.uploadVideoId ? item.uploadPhase : null,
			uploadError: item.uploadError,
		});
		if (
			!settled ||
			(settled.status === item.status && settled.error === item.error)
		) {
			continue;
		}
		await db()
			.update(loomImportJobItems)
			.set({
				status: settled.status,
				error: settled.error,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(loomImportJobItems.id, item.id),
					eq(loomImportJobItems.status, item.status),
				),
			);
	}

	let outcome: { started: number; completed: boolean } | null = null;
	for (const jobId of jobsToDispatch) {
		outcome = await dispatchLoomImportJob(jobId);
	}
	return outcome;
}

export async function isLoomImportedVideo(videoId: Video.VideoId) {
	const [row] = await db()
		.select({ id: importedVideos.id })
		.from(importedVideos)
		.where(
			and(eq(importedVideos.id, videoId), eq(importedVideos.source, "loom")),
		)
		.limit(1);
	return Boolean(row);
}
