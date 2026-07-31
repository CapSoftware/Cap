import type { ServerProductEvent } from "./server-event";

const occurredAt = (value: Date | string) =>
	value instanceof Date ? value.toISOString() : value;

export const userSignedUpEvent = (input: {
	userId: string;
	createdAt: Date | string;
}) =>
	({
		eventId: `signup:${input.userId}`,
		eventName: "user_signed_up",
		occurredAt: occurredAt(input.createdAt),
		platform: "web",
		userId: input.userId,
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
	platform: "desktop" | "mobile" | "server";
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
		platform: input.platform,
		userId: input.userId,
		organizationId: input.organizationId,
		properties: {
			asset_type: input.isScreenshot ? "screenshot" : "recording",
			recording_mode: input.sourceType,
		},
	}) satisfies ServerProductEvent;

export const checkoutStartedEvent = (input: {
	checkoutId: string;
	createdAt: Date | string;
	platform: "cli" | "desktop" | "mobile" | "web";
	userId: string;
	organizationId?: string | null;
	anonymousId?: string;
	priceId: string;
	quantity: number;
	isOnboarding?: boolean;
}) =>
	({
		eventId: `checkout:${input.checkoutId}`,
		eventName: "checkout_started",
		occurredAt: occurredAt(input.createdAt),
		anonymousId: input.anonymousId,
		platform: input.platform,
		userId: input.userId,
		organizationId: input.organizationId ?? undefined,
		properties: {
			price_id: input.priceId,
			quantity: input.quantity,
			...(input.isOnboarding === undefined
				? {}
				: { is_onboarding: input.isOnboarding }),
		},
	}) satisfies ServerProductEvent;

export const guestCheckoutStartedEvent = (input: {
	checkoutId: string;
	createdAt: Date | string;
	platform: "mobile" | "web";
	anonymousId: string;
	priceId: string;
	quantity: number;
}) =>
	({
		eventId: `checkout:${input.checkoutId}`,
		eventName: "guest_checkout_started",
		occurredAt: occurredAt(input.createdAt),
		anonymousId: input.anonymousId,
		platform: input.platform,
		properties: {
			price_id: input.priceId,
			quantity: input.quantity,
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
