import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";
import { getWorld } from "workflow/runtime";
import {
	getLoomImporterJobState,
	isLoomMediaJobFailed,
} from "@/lib/loom-media-dispatch";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

type LoomImportRun = NonNullable<VideoMetadata["loomImportRun"]>;
type ImportPayload = Parameters<typeof importLoomVideoWorkflow>[0];

export async function restoreLoomImportStartError(
	videoId: string,
	phase: "uploading" | "processing",
	claimedAt: Date,
	message: string,
) {
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: null,
			processingError: message,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, Video.VideoId.make(videoId)),
				eq(videoUploads.phase, phase),
				eq(videoUploads.updatedAt, claimedAt),
			),
		);
}

export class LoomImportStartError extends Error {
	constructor(
		readonly canRetry: boolean,
		cause: unknown,
	) {
		super(
			canRetry
				? "Loom import could not start. Please try again."
				: "We are confirming whether your Loom import started. Please check its progress before retrying.",
			{ cause },
		);
		this.name = "LoomImportStartError";
	}
}

export const LOOM_IMPORT_CONFIRMATION_MESSAGE =
	"We're confirming whether your Loom import started. Please contact support before retrying.";

const STUCK_PENDING_RUN_MS = 60 * 60 * 1000;

async function cancelStuckPendingRun(run: ReturnType<typeof getRun>) {
	try {
		const createdAt = await run.createdAt;
		if (Date.now() - createdAt.getTime() < STUCK_PENDING_RUN_MS) return false;
		await run.cancel();
		return (await run.status) === "cancelled";
	} catch {
		return false;
	}
}

export async function getLoomImportRunState(
	receipt?: LoomImportRun,
): Promise<"inactive" | "pending" | "active" | "unconfirmed"> {
	if (!receipt || receipt.dispatch === "rejected") return "inactive";
	const run = getRun(receipt.runId);
	let status: string;
	try {
		status = await run.status;
		if (status === "pending" && (await cancelStuckPendingRun(run)))
			status = "cancelled";
	} catch (error) {
		return WorkflowRunNotFoundError.is(error) &&
			receipt.dispatch === "uncertain" &&
			!receipt.mediaDispatch
			? "inactive"
			: "unconfirmed";
	}
	if (status !== "completed" && status !== "failed" && status !== "cancelled")
		return status === "pending" ? "pending" : "active";
	const mediaDispatch = receipt.mediaDispatch;
	if (!mediaDispatch || mediaDispatch.state === "rejected") return "inactive";
	if (mediaDispatch.worker !== "media" && mediaDispatch.videoId) {
		const importerState = await getLoomImporterJobState({
			jobId: mediaDispatch.jobId,
			videoId: mediaDispatch.videoId,
		});
		if (importerState === "running") return "active";
		if (importerState === "finished") return "inactive";
		if (importerState === "missing" && mediaDispatch.worker === "importer")
			return "inactive";
	}
	if (mediaDispatch.state === "accepted" && mediaDispatch.jobId)
		return mediaDispatch.videoId &&
			(await isLoomMediaJobFailed(mediaDispatch.jobId, mediaDispatch.videoId))
			? "inactive"
			: "unconfirmed";
	return "unconfirmed";
}

async function saveReceipt(payload: ImportPayload, receipt: LoomImportRun) {
	const result = await db()
		.update(videos)
		.set({
			metadata:
				receipt.dispatch === "pending"
					? sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomImportRun', JSON_EXTRACT(${JSON.stringify(receipt)}, '$'))`
					: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomImportRun', JSON_MERGE_PATCH(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun'), JSON_OBJECT()), JSON_EXTRACT(${JSON.stringify(receipt)}, '$')))`,
		})
		.where(
			and(
				eq(videos.id, Video.VideoId.make(payload.videoId)),
				eq(videos.ownerId, User.UserId.make(payload.userId)),
				receipt.dispatch === "pending"
					? undefined
					: sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId')) = ${receipt.runId}`,
			),
		);
	const affectedRows = Array.isArray(result)
		? (result[0] as { affectedRows?: number } | undefined)?.affectedRows
		: (result as { affectedRows?: number }).affectedRows;
	if (affectedRows !== 1)
		throw new Error("Could not record Loom import startup");
}

function isQueueRejection(error: unknown) {
	return (
		error instanceof Error &&
		[
			"BadRequestError",
			"UnauthorizedError",
			"ForbiddenError",
			"TooManyRequestsError",
		].includes(error.name)
	);
}

export async function startLoomImportWorkflow(payload: ImportPayload) {
	let attempted = false;
	let accepted = false;
	let rejected = false;
	let receipt: LoomImportRun | undefined;
	try {
		const world = getWorld();
		const observedWorld: ReturnType<typeof getWorld> = {
			...world,
			queue: async (name, message, options) => {
				if (!("runId" in message))
					throw new Error("Missing Loom import run ID");
				receipt = {
					runId: message.runId,
					dispatch: "pending",
					...(payload.importPriority === "bulk"
						? { importPriority: "bulk" as const }
						: {}),
				};
				await saveReceipt(payload, receipt);
				attempted = true;
				try {
					const result = await world.queue(name, message, options);
					accepted = true;
					return result;
				} catch (error) {
					rejected = isQueueRejection(error);
					throw error;
				}
			},
		};
		await start(importLoomVideoWorkflow, [payload], { world: observedWorld });
	} catch (error) {
		if (!accepted) {
			let canRetry = !attempted || rejected;
			if (receipt) {
				try {
					await saveReceipt(payload, {
						...receipt,
						dispatch: canRetry ? "rejected" : "uncertain",
					});
				} catch (receiptError) {
					canRetry = false;
					console.error(
						"Could not record Loom import dispatch failure",
						receiptError,
					);
				}
			}
			throw new LoomImportStartError(canRetry, error);
		}
		console.error("Loom import queued despite a startup error", error);
	}
	if (receipt) {
		await saveReceipt(payload, { ...receipt, dispatch: "accepted" }).catch(
			(error: unknown) => {
				console.error("Could not record accepted Loom import dispatch", error);
			},
		);
	}
}
