import { describe, expect, it } from "vitest";
import {
	decodeNotificationCursor,
	encodeNotificationCursor,
	libraryCapabilities,
	normalizeOrganization,
	organizationCapabilities,
	profileCapabilities,
} from "@/lib/agent-management";

describe("agent management capabilities", () => {
	it("requires both scope and organization role", () => {
		const scopes = new Set([
			"organizations:read",
			"organizations:manage",
			"organizations:members",
			"billing:write",
		] as const);
		const member = organizationCapabilities("member", scopes);
		expect(member.read.allowed).toBe(true);
		expect(member.update).toMatchObject({
			allowed: false,
			reason: "ROLE_REQUIRED",
		});
		const owner = organizationCapabilities("owner", scopes);
		expect(owner.update.allowed).toBe(true);
		expect(owner.manageBilling).toMatchObject({
			allowed: true,
			confirmation: "browser",
			sideEffect: "paid",
		});
	});

	it("keeps read, write, and destructive metadata explicit", () => {
		const scopes = new Set(["profile:read", "library:write"] as const);
		expect(profileCapabilities(scopes).read).toMatchObject({
			allowed: true,
			sideEffect: "read",
			idempotencyRequired: false,
		});
		expect(libraryCapabilities(true, scopes).delete).toMatchObject({
			allowed: true,
			confirmation: "user",
			sideEffect: "destructive",
			idempotencyRequired: true,
		});
	});

	it("normalizes organization settings and billing without secrets", () => {
		const result = normalizeOrganization(
			{
				id: "org_test" as never,
				name: "Test",
				ownerId: "user_test" as never,
				role: "owner",
				hasProSeat: true,
				allowedEmailDomain: null,
				customDomain: "caps.example.com",
				domainVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
				settings: { disableTranscript: true },
				icon: null,
				shareableLinkIcon: null,
				ownerSubscriptionStatus: "active",
				ownerThirdPartySubscriptionId: null,
				createdAt: new Date("2025-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
			new Set(["organizations:read"]),
		);
		expect(result.billing).toEqual({ status: "active", plan: "pro" });
		expect(result.settings.disableTranscript).toBe(true);
		expect(JSON.stringify(result)).not.toContain("stripeCustomerId");
	});
});

describe("notification cursor", () => {
	it("round trips opaque cursors and rejects tampering", () => {
		const cursor = {
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			id: "notification_1",
		};
		expect(decodeNotificationCursor(encodeNotificationCursor(cursor))).toEqual(
			cursor,
		);
		expect(decodeNotificationCursor("not-a-cursor")).toBeUndefined();
		expect(decodeNotificationCursor("a".repeat(1_025))).toBeUndefined();
	});
});
