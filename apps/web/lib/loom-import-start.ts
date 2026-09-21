import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
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

export async function isLoomImportRunning(receipt?: LoomImportRun) {
	if (!receipt || receipt.dispatch === "rejected") return false;
	try {
		const status = await getRun(receipt.runId).status;
		return (
			status !== "completed" && status !== "failed" && status !== "cancelled"
		);
	} catch {
		return true;
	}
}

async function saveReceipt(payload: ImportPayload, receipt: LoomImportRun) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomImportRun', JSON_EXTRACT(${JSON.stringify(receipt)}, '$'))`,
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
				receipt = { runId: message.runId, dispatch: "pending" };
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
