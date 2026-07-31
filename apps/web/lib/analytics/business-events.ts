import type { ServerProductEvent } from "./server-event";

const occurredAt = (value: Date | string) =>
	value instanceof Date ? value.toISOString() : value;

export const userSignedUpEvent = (input: {
	userId: string;
	organizationId?: string | null;
	createdAt: Date | string;
}) =>
	({
		eventId: `signup:${input.userId}`,
		eventName: "user_signed_up",
		occurredAt: occurredAt(input.createdAt),
		platform: "server",
		userId: input.userId,
		organizationId: input.organizationId ?? undefined,
	}) satisfies ServerProductEvent;

export const identityLinkedEvent = (input: {
	userId: string;
	organizationId?: string | null;
	anonymousId: string;
	createdAt: Date | string;
}) =>
	({
		eventId: `identity_linked:${input.userId}`,
		eventName: "identity_linked",
		occurredAt: occurredAt(input.createdAt),
		anonymousId: input.anonymousId,
		platform: "server",
		userId: input.userId,
		organizationId: input.organizationId ?? undefined,
	}) satisfies ServerProductEvent;

export const shareLinkCreatedEvent = (input: {
	videoId: string;
	userId: string;
	organizationId: string;
	createdAt: Date | string;
	isScreenshot: boolean;
	sourceType: string;
}) =>
	({
		eventId: `share_link_created:${input.videoId}`,
		eventName: "share_link_created",
		occurredAt: occurredAt(input.createdAt),
		platform: "server",
		userId: input.userId,
		organizationId: input.organizationId,
		properties: {
			asset_type: input.isScreenshot ? "screenshot" : "recording",
			recording_mode: input.sourceType,
		},
	}) satisfies ServerProductEvent;

export const collaborationActionCreatedEvent = (input: {
	commentId: string;
	userId: string;
	organizationId?: string | null;
	createdAt: Date | string;
	action: "comment" | "reaction" | "reply";
}) =>
	({
		eventId: `collaboration:${input.commentId}`,
		eventName: "collaboration_action_created",
		occurredAt: occurredAt(input.createdAt),
		platform: "server",
		userId: input.userId,
		organizationId: input.organizationId ?? undefined,
		properties: { action: input.action },
	}) satisfies ServerProductEvent;
