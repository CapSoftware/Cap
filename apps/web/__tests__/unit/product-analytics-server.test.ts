import { describe, expect, it } from "vitest";
import {
	collaborationActionCreatedEvent,
	firstViewReceivedEvent,
	identityLinkedEvent,
	shareLinkCreatedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
import { createServerProductEventRows } from "@/lib/analytics/server-event";

describe("server product analytics", () => {
	const purchaseProperties = {
		payment_status: "paid",
		subscription_status: "active",
		quantity: 3,
		is_first_purchase: true,
		is_guest_checkout: false,
		is_onboarding: false,
	} as const;

	it("builds a deterministic trusted server event", () => {
		const [row] = createServerProductEventRows({
			eventId: "stripe:evt_123:purchase_completed",
			eventName: "purchase_completed",
			occurredAt: "2026-07-12T12:00:00.000Z",
			anonymousId: "anonymous-1",
			platform: "web",
			userId: "user-1",
			organizationId: "org-1",
			properties: purchaseProperties,
		});

		expect(row).toMatchObject({
			event_id: "stripe:evt_123:purchase_completed",
			event_name: "purchase_completed",
			source: "server",
			platform: "web",
			anonymous_id: "anonymous-1",
			user_id: "user-1",
			organization_id: "org-1",
			properties:
				'{"payment_status":"paid","subscription_status":"active","quantity":3,"is_first_purchase":true,"is_guest_checkout":false,"is_onboarding":false}',
		});
	});

	it("uses an authenticated fallback identity", () => {
		const [row] = createServerProductEventRows({
			eventId: "signup:user-1",
			eventName: "user_signed_up",
			occurredAt: "2026-07-12T12:00:00.000Z",
			platform: "web",
			userId: "user-1",
		});
		expect(row?.anonymous_id).toBe("user:user-1");
	});

	it("marks bounded staging events as synthetic without exposing the run ID", () => {
		const [row] = createServerProductEventRows({
			_syntheticRunId: "run_staging_route_123",
			eventId: "signup:user-1",
			eventName: "user_signed_up",
			occurredAt: "2026-07-12T12:00:00.000Z",
			platform: "web",
			userId: "user-1",
		});

		expect(row).toMatchObject({
			synthetic_run_id: "run_staging_route_123",
			traffic_class: "synthetic",
		});
		expect(row?.properties).not.toContain("run_staging_route_123");
	});

	it("rejects an invalid synthetic staging run ID", () => {
		expect(
			createServerProductEventRows({
				_syntheticRunId: "contains spaces",
				eventId: "signup:user-1",
				eventName: "user_signed_up",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "web",
				userId: "user-1",
			}),
		).toEqual([]);
	});

	it("drops an event without any stable identity", () => {
		expect(
			createServerProductEventRows({
				eventId: "event-1",
				eventName: "user_signed_up",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "web",
			}),
		).toEqual([]);
	});

	it("rejects an invalid timestamp before delivery", () => {
		expect(
			createServerProductEventRows({
				eventId: "event-1",
				eventName: "purchase_completed",
				occurredAt: "invalid",
				platform: "server",
				userId: "user-1",
				properties: purchaseProperties,
			}),
		).toEqual([]);
	});

	it("rejects a property payload containing undeclared customer data", () => {
		const unsafeCreate = createServerProductEventRows as unknown as (
			event: Record<string, unknown>,
		) => unknown[];
		expect(
			unsafeCreate({
				eventId: "event-1",
				eventName: "user_signed_up",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "web",
				userId: "user-1",
				properties: { email: "private@example.com" },
			}),
		).toEqual([]);
	});

	it("rejects personal data and raw errors in declared server fields", () => {
		const unsafeCreate = createServerProductEventRows as unknown as (
			event: Record<string, unknown>,
		) => unknown[];
		expect(
			unsafeCreate({
				eventId: "stripe:evt_123:purchase_completed",
				eventName: "purchase_completed",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "server",
				userId: "user-1",
				properties: {
					...purchaseProperties,
					subscription_status: "alice@example.com",
				},
			}),
		).toEqual([]);
		expect(
			unsafeCreate({
				eventId: "loom_import:video-1:failed",
				eventName: "loom_import_failed",
				occurredAt: "2026-07-12T12:00:00.000Z",
				platform: "server",
				userId: "user-1",
				properties: {
					import_mode: "video",
					failure_class: "Failed reading /Users/alice/private.mp4",
				},
			}),
		).toEqual([]);
		expect(
			unsafeCreate({
				eventId: "signup:user-1",
				eventName: "user_signed_up",
				platform: "web",
				userId: "person@example.com",
			}),
		).toEqual([]);
	});

	it("builds reconciliation-compatible authoritative business facts", () => {
		const facts = [
			userSignedUpEvent({
				userId: "user-1",
				createdAt: "2026-07-31T10:00:00.000Z",
			}),
			shareLinkCreatedEvent({
				videoId: "video-1",
				platform: "server",
				userId: "user-1",
				organizationId: "org-1",
				createdAt: "2026-07-31T10:01:00.000Z",
				isScreenshot: false,
				sourceType: "desktopSegments",
			}),
			collaborationActionCreatedEvent({
				commentId: "comment-1",
				userId: "user-1",
				organizationId: "org-1",
				createdAt: "2026-07-31T10:02:00.000Z",
				action: "comment",
			}),
			firstViewReceivedEvent({
				videoId: "video-1",
				userId: "user-1",
				organizationId: "org-1",
				createdAt: "2026-07-31T10:03:00.000Z",
			}),
		] as const;

		for (const fact of facts) {
			const first = createServerProductEventRows(fact)[0];
			const reconciled = createServerProductEventRows({ ...fact })[0];
			expect(reconciled?.event_id).toBe(first?.event_id);
			expect(reconciled?.payload_hash).toBe(first?.payload_hash);
		}
	});

	it("links signup attribution without changing the signup fact", () => {
		const signup = createServerProductEventRows(
			userSignedUpEvent({
				userId: "user-1",
				createdAt: "2026-07-31T10:00:00.000Z",
			}),
		)[0];
		const link = createServerProductEventRows(
			identityLinkedEvent({
				userId: "user-1",
				organizationId: "org-1",
				anonymousId: "anonymous-1",
				createdAt: "2026-07-31T10:00:00.000Z",
			}),
		)[0];

		expect(signup?.anonymous_id).toBe("user:user-1");
		expect(link).toMatchObject({
			event_id: "identity_linked:user-1",
			event_name: "identity_linked",
			anonymous_id: "anonymous-1",
			user_id: "user-1",
		});
	});
});
