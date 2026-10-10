import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	loomImportDispatchLocks,
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
import { LOOM_IMPORT_JOB_STATUS_INDEX } from "./indexes";
import {
	addLoomImportLoad,
	type LoomImportQueueJob,
	type LoomImportQueueLoad,
	pickLoomImportJob,
} from "./schedule";
import { settleLoomImportItem } from "./status";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const DEFAULT_GLOBAL_CONCURRENCY = 12;
const MAX_GLOBAL_CONCURRENCY = 256;
const LAUNCH_BURST = 4;
const MAX_CLAIMS_PER_PASS = 32;
const MAX_PASSES = 8;
const LOCK_RETRY_ATTEMPTS = 6;
const DISPATCH_LOCK_ID = "global";
const OPEN_ITEM_STATUSES = ["pending", "ready", "importing"] as const;
export const LOOM_IMPORT_WAITING_PREFIX = "Queued for Loom import";
const START_RETRY_NOTE = "Starting this import again.";
const START_FAILED_ERROR = "Loom import could not start.";
const STORAGE_ERROR = "We couldn't prepare storage for this video.";
const NO_OWNER_ERROR = "We couldn't find an owner for this video.";

type VideoInsert = typeof videos.$inferInsert;
type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

type Writable = {
	bucketId: NonNullable<VideoInsert["bucket"]> | null;
	storageIntegrationId: NonNullable<VideoInsert["storageIntegrationId"]> | null;
};

type ActiveJob = LoomImportQueueJob & {
	orgId: Organisation.OrganisationId;
};

type ClaimedItem = NonNullable<Awaited<ReturnType<typeof claimNextItem>>>;

type Launch = {
	itemId: string;
	jobId: string;
	videoId: Video.VideoId;
	ownerId: User.UserId;
	rawFileKey: string;
	bucketId: string | null;
	loomVideoId: string;
	reuseExistingRawUpload: boolean;
	startRetried: boolean;
};

type PassContext = {
	tx: Transaction;
	now: Date;
	storage: Map<string, Writable | null>;
	publicByOrg: Map<string, boolean>;
};

export type LoomImportDispatchOutcome = {
	started: number;
	startedByJob: Map<string, number>;
	completedJobs: Set<string>;
	inFlight: number;
	waiting: boolean;
};

function configuredLimit(value: string | undefined, fallback: number) {
	const configured = Number.parseInt(value ?? "", 10);
	return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function loomImportConcurrency() {
	return Math.min(
		configuredLimit(serverEnv().LOOM_IMPORT_CONCURRENCY, DEFAULT_CONCURRENCY),
		MAX_CONCURRENCY,
	);
}

export function loomImportGlobalConcurrency() {
	return Math.min(
		configuredLimit(
			serverEnv().LOOM_IMPORT_GLOBAL_CONCURRENCY,
			DEFAULT_GLOBAL_CONCURRENCY,
		),
		MAX_GLOBAL_CONCURRENCY,
	);
}

function hasMysqlError(error: unknown, errnos: number[]): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		if (
			typeof current === "object" &&
			"errno" in current &&
			errnos.includes((current as { errno?: unknown }).errno as number)
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

function isDuplicateKeyError(error: unknown) {
	return hasMysqlError(error, [1062]);
}

function isRetryableLockError(error: unknown) {
	return hasMysqlError(error, [1205, 1213, 1305]);
}

export function rawFileKeyFor(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/raw-upload.mp4`;
}

async function writableFor(
	cache: Map<string, Writable | null>,
	ownerId: User.UserId,
	orgId: Organisation.OrganisationId,
) {
	const key = `${orgId}:${ownerId}`;
	if (cache.has(key)) return cache.get(key) ?? null;
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
	cache.set(key, writable);
	return writable;
}

async function isPublicFor(
	cache: Map<string, boolean>,
	orgId: Organisation.OrganisationId,
) {
	const cached = cache.get(orgId);
	if (cached !== undefined) return cached;
	const isPublic = await getNewVideoPublic(orgId);
	cache.set(orgId, isPublic);
	return isPublic;
}

async function settleInFlight(context: PassContext) {
	const { tx, now } = context;
	const rows = await tx
		.select({
			id: loomImportJobItems.id,
			jobId: loomImportJobItems.jobId,
			creatorId: loomImportJobs.createdById,
			videoId: loomImportJobItems.videoId,
			videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
			uploadVideoId: videoUploads.videoId,
			uploadPhase: videoUploads.phase,
			uploadMessage: videoUploads.processingMessage,
			uploadError: videoUploads.processingError,
		})
		.from(loomImportJobItems)
		.innerJoin(loomImportJobs, eq(loomImportJobs.id, loomImportJobItems.jobId))
		.leftJoin(videos, eq(videos.id, loomImportJobItems.videoId))
		.leftJoin(
			videoUploads,
			eq(videoUploads.videoId, loomImportJobItems.videoId),
		)
		.where(eq(loomImportJobItems.status, "importing"));

	const load: LoomImportQueueLoad = { jobs: new Map(), creators: new Map() };
	const completedIds: string[] = [];
	const failures = new Map<string, string[]>();
	let inFlight = 0;
	let waiting = false;
	for (const row of rows) {
		const settled = settleLoomImportItem({
			status: "importing",
			videoExists: Boolean(row.videoId && row.videoExists),
			uploadPhase: row.uploadVideoId ? row.uploadPhase : null,
			uploadError: row.uploadError,
		});
		if (settled) {
			if (settled.status === "complete") completedIds.push(row.id);
			else
				failures.set(settled.error, [
					...(failures.get(settled.error) ?? []),
					row.id,
				]);
			continue;
		}
		inFlight++;
		addLoomImportLoad(load, { id: row.jobId, creatorId: row.creatorId });
		if (row.uploadMessage?.startsWith(LOOM_IMPORT_WAITING_PREFIX)) {
			waiting = true;
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

	return { load, inFlight, waiting };
}

async function claimNextItem(tx: Transaction, jobId: string) {
	const [item] = await tx
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
			error: loomImportJobItems.error,
		})
		.from(loomImportJobItems, { forceIndex: LOOM_IMPORT_JOB_STATUS_INDEX })
		.where(
			and(
				eq(loomImportJobItems.jobId, jobId),
				eq(loomImportJobItems.status, "ready"),
			),
		)
		.orderBy(asc(loomImportJobItems.rowNumber))
		.limit(1)
		.for("update");
	return item;
}

async function launchItem(
	context: PassContext,
	job: ActiveJob,
	item: ClaimedItem,
): Promise<Launch | null> {
	const { tx, now } = context;
	const startRetried = item.error === START_RETRY_NOTE;
	if (!item.ownerId || !item.loomVideoId) {
		await tx
			.update(loomImportJobItems)
			.set({ status: "failed", error: NO_OWNER_ERROR, updatedAt: now })
			.where(eq(loomImportJobItems.id, item.id));
		return null;
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
			return {
				itemId: item.id,
				jobId: job.id,
				videoId: existing.id,
				ownerId: existing.ownerId,
				rawFileKey,
				bucketId: existing.bucket,
				loomVideoId: item.loomVideoId,
				reuseExistingRawUpload: true,
				startRetried,
			};
		}
	}

	const writable = await writableFor(context.storage, item.ownerId, job.orgId);
	if (!writable) {
		await tx
			.update(loomImportJobItems)
			.set({ status: "failed", error: STORAGE_ERROR, updatedAt: now })
			.where(
				and(
					eq(loomImportJobItems.jobId, job.id),
					eq(loomImportJobItems.ownerId, item.ownerId),
					eq(loomImportJobItems.status, "ready"),
				),
			);
		return null;
	}

	const isPublic = await isPublicFor(context.publicByOrg, job.orgId);
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
				...(item.durationSeconds ? { duration: item.durationSeconds } : {}),
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
		return null;
	}

	return {
		itemId: item.id,
		jobId: job.id,
		videoId,
		ownerId,
		rawFileKey,
		bucketId: writable.bucketId,
		loomVideoId,
		reuseExistingRawUpload: false,
		startRetried,
	};
}

async function startLaunch(launch: Launch) {
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
		return true;
	} catch (error) {
		console.error("[loom-import] Could not start import workflow", {
			videoId: launch.videoId,
			retried: launch.startRetried,
			error,
		});
	}

	const now = new Date();
	if (!launch.startRetried) {
		await db()
			.update(loomImportJobItems)
			.set({ status: "ready", error: START_RETRY_NOTE, updatedAt: now })
			.where(
				and(
					eq(loomImportJobItems.id, launch.itemId),
					eq(loomImportJobItems.status, "importing"),
				),
			);
		return false;
	}
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingError: START_FAILED_ERROR,
			processingMessage: "Loom import failed",
			updatedAt: now,
		})
		.where(eq(videoUploads.videoId, launch.videoId));
	await db()
		.update(loomImportJobItems)
		.set({ status: "failed", error: START_FAILED_ERROR, updatedAt: now })
		.where(eq(loomImportJobItems.id, launch.itemId));
	return false;
}

async function runDispatchPass() {
	const perJob = loomImportConcurrency();
	const globalLimit = loomImportGlobalConcurrency();

	return db().transaction(async (tx) => {
		const now = new Date();
		const context: PassContext = {
			tx,
			now,
			storage: new Map(),
			publicByOrg: new Map(),
		};
		await tx
			.insert(loomImportDispatchLocks)
			.values({ id: DISPATCH_LOCK_ID, lockedAt: now })
			.onDuplicateKeyUpdate({ set: { lockedAt: now } });

		// Cancelling locks its job row and then its items, so the job rows are
		// locked here before any item. They are locked by primary key: a locking
		// scan of the status index deadlocks with cancel updating that index.
		const activeIds = await tx
			.select({ id: loomImportJobs.id })
			.from(loomImportJobs)
			.where(eq(loomImportJobs.status, "importing"));
		const locked = activeIds.length
			? await tx
					.select({
						id: loomImportJobs.id,
						status: loomImportJobs.status,
						orgId: loomImportJobs.orgId,
						creatorId: loomImportJobs.createdById,
						dispatchedAt: loomImportJobs.dispatchedAt,
						startedAt: loomImportJobs.startedAt,
					})
					.from(loomImportJobs)
					.where(
						inArray(
							loomImportJobs.id,
							activeIds.map((job) => job.id),
						),
					)
					.orderBy(asc(loomImportJobs.id))
					.for("update")
			: [];
		const active: ActiveJob[] = locked.filter(
			(job) => job.status === "importing",
		);

		const { load, inFlight, waiting } = await settleInFlight(context);

		const candidates = new Map(active.map((job) => [job.id, job]));
		const launches: Launch[] = [];
		const room = waiting
			? 0
			: Math.max(0, Math.min(LAUNCH_BURST, globalLimit - inFlight));
		let claims = 0;
		while (launches.length < room && claims < MAX_CLAIMS_PER_PASS) {
			const job = pickLoomImportJob(candidates.values(), load, perJob);
			if (!job) break;
			claims++;
			const item = await claimNextItem(tx, job.id);
			if (!item) {
				candidates.delete(job.id);
				continue;
			}
			const launch = await launchItem(context, job, item);
			if (!launch) continue;
			launches.push(launch);
			addLoomImportLoad(load, job);
		}

		const launchedJobs = new Set(launches.map((launch) => launch.jobId));
		const idle = active
			.map((job) => job.id)
			.filter((id) => !launchedJobs.has(id) && !load.jobs.get(id));
		const finished = idle.length
			? await tx
					.select({ id: loomImportJobs.id })
					.from(loomImportJobs)
					.where(
						and(
							inArray(loomImportJobs.id, idle),
							eq(loomImportJobs.status, "importing"),
							...OPEN_ITEM_STATUSES.map(
								(status) =>
									sql`NOT EXISTS (SELECT 1 FROM ${loomImportJobItems} FORCE INDEX (${sql.raw(LOOM_IMPORT_JOB_STATUS_INDEX)}) WHERE ${loomImportJobItems.jobId} = ${loomImportJobs.id} AND ${loomImportJobItems.status} = ${status})`,
							),
						),
					)
			: [];
		const completedJobs = new Set(finished.map((job) => job.id));
		if (completedJobs.size > 0) {
			await tx
				.update(loomImportJobs)
				.set({ status: "completed", completedAt: now, updatedAt: now })
				.where(
					and(
						inArray(loomImportJobs.id, Array.from(completedJobs)),
						eq(loomImportJobs.status, "importing"),
					),
				);
		}
		let order = 0;
		for (const jobId of launchedJobs) {
			await tx
				.update(loomImportJobs)
				.set({
					dispatchedAt: new Date(now.getTime() + order++),
					updatedAt: now,
				})
				.where(eq(loomImportJobs.id, jobId));
		}

		return {
			launches,
			completedJobs,
			inFlight: inFlight + launches.length,
			waiting,
			unfinished:
				claims >= MAX_CLAIMS_PER_PASS &&
				launches.length < room &&
				candidates.size > 0,
		};
	});
}

async function runDispatchPassWithRetry() {
	for (let attempt = 1; ; attempt++) {
		try {
			return await runDispatchPass();
		} catch (error) {
			if (attempt >= LOCK_RETRY_ATTEMPTS || !isRetryableLockError(error)) {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 50),
			);
		}
	}
}

export async function dispatchLoomImports(): Promise<LoomImportDispatchOutcome> {
	const outcome: LoomImportDispatchOutcome = {
		started: 0,
		startedByJob: new Map(),
		completedJobs: new Set(),
		inFlight: 0,
		waiting: false,
	};
	for (let passes = 0; passes < MAX_PASSES; passes++) {
		const pass = await runDispatchPassWithRetry();
		let failedStarts = 0;
		for (const launch of pass.launches) {
			if (!(await startLaunch(launch))) {
				failedStarts++;
				continue;
			}
			outcome.started++;
			outcome.startedByJob.set(
				launch.jobId,
				(outcome.startedByJob.get(launch.jobId) ?? 0) + 1,
			);
		}
		for (const jobId of pass.completedJobs) outcome.completedJobs.add(jobId);
		outcome.inFlight = pass.inFlight - failedStarts;
		outcome.waiting = pass.waiting;
		if (!pass.unfinished && failedStarts === 0) break;
	}
	return outcome;
}

export async function dispatchLoomImportJob(jobId: string) {
	const outcome = await dispatchLoomImports();
	const [job] = await db()
		.select({ status: loomImportJobs.status })
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId))
		.limit(1);
	return {
		started: outcome.startedByJob.get(jobId) ?? 0,
		completed: job?.status === "completed",
	};
}

export async function dispatchLoomImportForVideo(videoId: string) {
	const items = await db()
		.select({
			id: loomImportJobItems.id,
			status: loomImportJobItems.status,
			error: loomImportJobItems.error,
			videoExists: sql<number>`${videos.id} IS NOT NULL`.mapWith(Number),
			uploadVideoId: videoUploads.videoId,
			uploadPhase: videoUploads.phase,
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
				eq(loomImportJobItems.videoId, Video.VideoId.make(videoId)),
				inArray(loomImportJobItems.status, ["importing", "failed", "complete"]),
			),
		);
	if (items.length === 0) return null;

	let inFlight = false;
	for (const item of items) {
		if (item.status === "importing") {
			inFlight = true;
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

	return inFlight ? dispatchLoomImports() : null;
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
