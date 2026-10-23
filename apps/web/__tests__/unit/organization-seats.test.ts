import { describe, expect, it } from "vitest";
import { calculateProSeats, selectProSeatProvider } from "@/utils/organization";

process.env.NEXT_PUBLIC_IS_CAP = "true";
process.env.NEXT_PUBLIC_WEB_URL = "http://localhost:3000";

describe("organization Pro seat capacity", () => {
	it("counts an entitled owner even when the membership flag is false", () => {
		expect(
			calculateProSeats({
				inviteQuota: 1,
				ownerId: "owner",
				ownerIsPro: true,
				members: [
					{
						id: "owner-membership",
						userId: "owner",
						hasProSeat: false,
					},
				],
			}),
		).toMatchObject({
			proSeatsUsed: 1,
			proSeatsRemaining: 0,
		});
	});
});

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

	it("does not expose seats without an active subscription", () => {
		const owner = {
			id: "owner",
			inviteQuota: 1,
			stripeSubscriptionId: null,
			stripeSubscriptionStatus: null,
		};
		const actor = {
			id: "admin",
			inviteQuota: 1,
			stripeSubscriptionId: null,
			stripeSubscriptionStatus: null,
		};

		expect(
			selectProSeatProvider({
				actor,
				owner,
				actorCanManageProSeats: true,
			}),
		).toBeNull();
	});
});
