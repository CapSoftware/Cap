import { describe, expect, it } from "vitest";
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
			platform: "server",
			userId: "user-1",
		});
		expect(row?.anonymous_id).toBe("user:user-1");
	});

	it("drops an event without any stable identity", () => {
		expect(
			createServerProductEventRows({
				eventId: "event-1",
				eventName: "user_signed_up",
				platform: "server",
			}),
		).toEqual([]);
	});

	it("replaces an invalid timestamp with the receive time", () => {
		const [row] = createServerProductEventRows({
			eventId: "event-1",
			eventName: "purchase_completed",
			occurredAt: "invalid",
			platform: "server",
			userId: "user-1",
			properties: purchaseProperties,
		});

		expect(row?.occurred_at).toBe(row?.received_at);
		expect(Number.isFinite(Date.parse(row?.occurred_at ?? ""))).toBe(true);
	});

	it("rejects a property payload containing undeclared customer data", () => {
		const unsafeCreate = createServerProductEventRows as unknown as (
			event: Record<string, unknown>,
		) => unknown[];
		expect(
			unsafeCreate({
				eventId: "event-1",
				eventName: "user_signed_up",
				platform: "server",
				userId: "user-1",
				properties: { email: "private@example.com" },
			}),
		).toEqual([]);
	});
});
