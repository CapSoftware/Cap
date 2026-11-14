import "server-only";

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

export async function emitAppStoreEvent(
	type: CapEventType,
	videoId: Video.VideoId,
	options: { commentId?: string } = {},
): Promise<number> {
	const [video] = await db()
		.select({ ownerId: videos.ownerId, orgId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) return 0;

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
	const [inserted] = await db()
		.insert(appStoreEvents)
		.ignore()
		.values({ id: eventId, type, videoId });
	if (inserted.affectedRows === 0) return 0;

	const createdAt = new Date().toISOString();
	return startJobs(
		installations.map((row) => ({
			kind: "event" as const,
			installationId: row.id,
			eventId,
			type,
			videoId,
			commentId: options.commentId,
			createdAt,
		})),
	);
}

function runInBackground(label: string, work: Promise<unknown>) {
	const guarded = work.catch((error: unknown) => {
		console.error(`[app-store] ${label} failed`, {
			message: error instanceof Error ? error.message : String(error),
		});
	});
	try {
		after(guarded);
	} catch {
		void guarded;
	}
}

export function announceAppStoreEvent(
	type: CapEventType,
	videoId: Video.VideoId,
	options: { commentId?: string } = {},
): void {
	runInBackground(
		`${type} for ${videoId}`,
		emitAppStoreEvent(type, videoId, options),
	);
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
