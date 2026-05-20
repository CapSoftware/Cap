import { describe, expect, it } from "vitest";
import { selectProSeatProvider } from "@/utils/organization";

describe("organization Pro seat provider selection", () => {
	it("uses an admin's larger active subscription when they manage Pro seats", () => {
		const owner = {
			id: "owner",
			inviteQuota: 1,
			stripeSubscriptionId: "sub_owner",
			stripeSubscriptionStatus: "active",
		};
		const actor = {
			id: "admin",
			inviteQuota: 5,
			stripeSubscriptionId: "sub_admin",
			stripeSubscriptionStatus: "active",
		};

		expect(
			selectProSeatProvider({
				actor,
				owner,
				actorCanManageProSeats: true,
			})?.id,
		).toBe("admin");
	});

	it("falls back to the owner subscription when the actor cannot manage Pro seats", () => {
		const owner = {
			id: "owner",
			inviteQuota: 1,
			stripeSubscriptionId: "sub_owner",
			stripeSubscriptionStatus: "active",
		};
		const actor = {
			id: "member",
			inviteQuota: 5,
			stripeSubscriptionId: "sub_member",
			stripeSubscriptionStatus: "active",
		};

		expect(
			selectProSeatProvider({
				actor,
				owner,
				actorCanManageProSeats: false,
			})?.id,
		).toBe("owner");
	});

	it("uses the larger active subscription between owner and actor", () => {
		const owner = {
			id: "owner",
			inviteQuota: 10,
			stripeSubscriptionId: "sub_owner",
			stripeSubscriptionStatus: "active",
		};
		const actor = {
			id: "admin",
			inviteQuota: 5,
			stripeSubscriptionId: "sub_admin",
			stripeSubscriptionStatus: "active",
		};

		expect(
			selectProSeatProvider({
				actor,
				owner,
				actorCanManageProSeats: true,
			})?.id,
		).toBe("owner");
	});
});
