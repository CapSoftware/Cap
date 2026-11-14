import { createHash } from "node:crypto";
import type { CapEventType } from "@cap/app-store";
import { db } from "@cap/database";
import {
	appStoreEvents,
	appStoreInstallations,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, or } from "drizzle-orm";
import { after } from "next/server";
import { start } from "workflow/api";
import { deliverAppStoreRequestWorkflow } from "@/workflows/deliver-app-store-request";
import { getCatalogApp } from "./catalog";
import type { AppStoreDeliveryJob } from "./delivery";
import { eventIsGranted } from "./installations";

export const appStoreEventId = (
	type: CapEventType,
	videoId: string,
	subjectId = "",
) =>
	`evt_${createHash("sha256")
		.update(`${type}:${videoId}:${subjectId}`)
		.digest("hex")
		.slice(0, 32)}`;

export const CAP_READY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isNewRecording(
	video: Pick<typeof videos.$inferSelect, "createdAt" | "metadata">,
	now: number = Date.now(),
) {
	if (video.metadata?.loomImportRun || video.metadata?.loomImportUpload) {
		return false;
	}
	return now - video.createdAt.getTime() <= CAP_READY_MAX_AGE_MS;
}

async function startJobs(jobs: AppStoreDeliveryJob[]) {
	const started = await Promise.allSettled(
		jobs.map((job) => start(deliverAppStoreRequestWorkflow, [job])),
	);
	const failed = started.filter((result) => result.status === "rejected");
	if (failed.length > 0) {
		console.error("[app-store] Failed to queue deliveries", {
			failed: failed.length,
		});
	}
	return jobs.length - failed.length;
}

export const appStoreDeliveryKey = (eventId: string, installationId: string) =>
	`dlv_${createHash("sha256")
		.update(`${eventId}:${installationId}`)
		.digest("hex")
		.slice(0, 40)}`;

// The marker is per installation and removed again when the workflow cannot
// be started, so a failed enqueue is retried by the next emission of the same
// event instead of being suppressed forever.
async function queueEventDelivery(
	job: Extract<AppStoreDeliveryJob, { kind: "event" }>,
): Promise<boolean> {
	const key = appStoreDeliveryKey(job.eventId, job.installationId);
	const [inserted] = await db()
		.insert(appStoreEvents)
		.ignore()
		.values({ id: key, type: job.type, videoId: job.videoId as Video.VideoId });
	if (inserted.affectedRows === 0) return false;
	try {
		await start(deliverAppStoreRequestWorkflow, [job]);
		return true;
	} catch (error) {
		await db()
			.delete(appStoreEvents)
			.where(eq(appStoreEvents.id, key))
			.catch(() => undefined);
		console.error("[app-store] Failed to queue a delivery", {
			installationId: job.installationId,
			message: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

export async function emitAppStoreEvent(
	type: CapEventType,
	videoId: Video.VideoId,
	options: { commentId?: string } = {},
): Promise<number> {
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			orgId: videos.orgId,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) return 0;
	if (type === "cap.ready" && !isNewRecording(video)) return 0;

	const scopes = [
		and(
			eq(appStoreInstallations.scope, "user"),
			eq(appStoreInstallations.userId, video.ownerId),
		),
	];
	if (video.orgId) {
		scopes.push(
			and(
				eq(appStoreInstallations.scope, "organization"),
				eq(appStoreInstallations.organizationId, video.orgId),
			),
		);
	}
	const installations = (
		await db()
			.select({
				id: appStoreInstallations.id,
				appId: appStoreInstallations.appId,
				grantedEvents: appStoreInstallations.grantedEvents,
				grantedPermissions: appStoreInstallations.grantedPermissions,
			})
			.from(appStoreInstallations)
			.where(and(eq(appStoreInstallations.status, "active"), or(...scopes)))
	).filter(
		(row) =>
			eventIsGranted(row, type) && !!getCatalogApp(row.appId)?.connection,
	);
	if (installations.length === 0) return 0;

	const eventId = appStoreEventId(type, videoId, options.commentId);
	const createdAt = new Date().toISOString();
	const queued = await Promise.all(
		installations.map((row) =>
			queueEventDelivery({
				kind: "event",
				installationId: row.id,
				eventId,
				type,
				videoId,
				commentId: options.commentId,
				createdAt,
			}),
		),
	);
	return queued.filter(Boolean).length;
}

function runInBackground(label: string, work: Promise<unknown>) {
	const guarded = work.catch((error: unknown) => {
		console.error("[app-store] Background task failed", {
			task: label,
			message: error instanceof Error ? error.message : String(error),
		});
	});
	try {
		after(guarded);
	} catch {
		void guarded;
	}
}

export function announceLifecycle(
	installationId: string,
	type: "installed" | "settings.updated",
): void {
	runInBackground(
		`${type} for ${installationId}`,
		startJobs([{ kind: "lifecycle", installationId, type }]),
	);
}

export function announceInBackground(label: string, work: Promise<unknown>) {
	runInBackground(label, work);
}
