import { db } from "@cap/database";
import {
	developerVideos,
	developerWebhookEndpoints,
} from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { after } from "next/server";
import { start } from "workflow/api";
import { serializeDeveloperVideo } from "@/lib/developer-video-api";
import type {
	DeveloperVideoEventStep,
	WebhookEventType,
} from "@/lib/developer-webhook-events";
import { developerVideoEventId } from "@/lib/developer-webhook-signature";
import { deliverDeveloperWebhookWorkflow } from "@/workflows/deliver-developer-webhook";

const STATUS_OF_EVENT: Record<WebhookEventType, string> = {
	"video.ready": "ready",
	"video.errored": "errored",
};

// A ready video still carrying the marker has not been announced, which is
// also what a rolled back announcement leaves behind.
function eventIsCommitted(
	video: typeof developerVideos.$inferSelect,
	type: WebhookEventType,
): boolean {
	if (video.deletedAt || video.status !== STATUS_OF_EVENT[type]) return false;
	return type !== "video.ready" || video.processing?.readyEventDueAt == null;
}

async function subscribedEndpointIds(
	appId: string,
	type: WebhookEventType,
): Promise<string[]> {
	const endpoints = await db()
		.select({
			id: developerWebhookEndpoints.id,
			events: developerWebhookEndpoints.events,
		})
		.from(developerWebhookEndpoints)
		.where(
			and(
				eq(developerWebhookEndpoints.appId, appId),
				isNull(developerWebhookEndpoints.deletedAt),
				eq(developerWebhookEndpoints.enabled, true),
			),
		);
	return endpoints
		.filter(
			(endpoint) =>
				Array.isArray(endpoint.events) && endpoint.events.includes(type),
		)
		.map((endpoint) => endpoint.id);
}

// The caller is still inside the transaction that changes the status. The
// locking read waits for that transaction to end, so the event is built from
// what was committed, and a change that was rolled back sends nothing.
async function committedVideo(videoId: string) {
	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.for("update");
	return video ?? null;
}

export async function enqueueDeveloperVideoEvent(
	target: { id: string; appId: string },
	type: WebhookEventType,
): Promise<number> {
	const endpointIds = await subscribedEndpointIds(target.appId, type);
	if (endpointIds.length === 0) return 0;

	const video = await committedVideo(target.id);
	if (!video || !eventIsCommitted(video, type)) return 0;

	const eventId = developerVideoEventId(video.id, type);
	const body = JSON.stringify({
		id: eventId,
		type,
		createdAt: new Date().toISOString(),
		data: serializeDeveloperVideo(video),
	});
	const started = await Promise.allSettled(
		endpointIds.map((endpointId) =>
			start(deliverDeveloperWebhookWorkflow, [
				{ endpointId, eventId, eventType: type, body },
			]),
		),
	);
	const failures = started.filter((result) => result.status === "rejected");
	if (failures.length > 0) {
		console.error("[developer-webhook] Failed to queue deliveries", {
			videoId: video.id,
			eventId,
			failed: failures.length,
		});
	}
	return started.length - failures.length;
}

// Never awaited: a video's status change must not wait for, or fail on,
// anything to do with webhooks.
export function announceDeveloperVideoEvent(
	video: { id: string; appId: string },
	step: DeveloperVideoEventStep,
): void {
	const type = step.type;
	if (!type) return;
	const queued = enqueueDeveloperVideoEvent(video, type).catch((error) => {
		console.error("[developer-webhook] Failed to queue an event", {
			videoId: video.id,
			type,
			message: error instanceof Error ? error.message : String(error),
		});
	});
	try {
		after(queued);
	} catch {
		void queued;
	}
}
