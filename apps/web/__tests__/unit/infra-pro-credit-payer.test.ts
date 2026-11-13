import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isCap: true,
	retrieve: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "txn",
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
}));
vi.mock("@cap/utils", () => ({
	userIsPro: () => true,
	stripe: () => ({ subscriptions: { retrieve: mocks.retrieve } }),
}));

import type { User } from "@cap/web-domain";
import { proCreditPayer } from "@/lib/infra-pro-credit";

const subscription = (
	id: string,
	status: string,
	quantities: number[] = [1],
) => ({
	id,
	status,
	items: { data: quantities.map((quantity) => ({ quantity })) },
});

const member = (fields: Record<string, string | null> = {}) => ({
	id: "user-1" as User.UserId,
	stripeSubscriptionId: null,
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
	...fields,
});

const direct = member({
	stripeSubscriptionId: "sub_own",
	stripeSubscriptionStatus: "active",
});
const seated = member({ thirdPartyStripeSubscriptionId: "sub_team" });

beforeEach(() => {
	mocks.isCap = true;
	mocks.retrieve.mockReset();
});

describe("the subscription that pays for a Cap Pro credit", () => {
	it("is a direct subscriber's own subscription", async () => {
		mocks.retrieve.mockResolvedValue(subscription("sub_own", "active"));

		expect(await proCreditPayer(direct)).toEqual({
			state: "ok",
			subscription: { id: "sub_own", seats: 1 },
		});
		expect(mocks.retrieve).toHaveBeenCalledWith("sub_own");
	});

	it("is the team subscription for a member on a seat, with its paid seats", async () => {
		mocks.retrieve.mockResolvedValue(
			subscription("sub_team", "active", [3, 2]),
		);

		expect(await proCreditPayer(seated)).toEqual({
			state: "ok",
			subscription: { id: "sub_team", seats: 5 },
		});
		expect(mocks.retrieve).toHaveBeenCalledWith("sub_team");
	});

	it("is the member's own subscription when they have both", async () => {
		mocks.retrieve.mockResolvedValue(subscription("sub_own", "active"));

		await proCreditPayer({
			...direct,
			thirdPartyStripeSubscriptionId: "sub_team",
		});

		expect(mocks.retrieve).toHaveBeenCalledWith("sub_own");
	});

	it("falls back to the team subscription when the member's own is a trial", async () => {
		mocks.retrieve.mockResolvedValue(subscription("sub_team", "active"));

		await proCreditPayer({
			...seated,
			stripeSubscriptionId: "sub_own",
			stripeSubscriptionStatus: "trialing",
		});

		expect(mocks.retrieve).toHaveBeenCalledWith("sub_team");
	});

	it("refuses a seat on a team subscription that is still a trial", async () => {
		mocks.retrieve.mockResolvedValue(subscription("sub_team", "trialing"));

		expect(await proCreditPayer(seated)).toEqual({
			state: "refused",
			message:
				"Your $5 monthly Infra credit starts with your first paid month of Cap Pro.",
		});
	});

	it("still allows a subscription that is past due", async () => {
		mocks.retrieve.mockResolvedValue(subscription("sub_team", "past_due"));

		expect((await proCreditPayer(seated)).state).toBe("ok");
	});

	it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"])(
		"refuses a seat whose subscription is %s",
		async (status) => {
			mocks.retrieve.mockResolvedValue(subscription("sub_team", status));

			expect(await proCreditPayer(seated)).toEqual({
				state: "refused",
				message: "This credit comes with Cap Pro.",
			});
		},
	);

	it("grants nothing when the subscription cannot be read", async () => {
		mocks.retrieve.mockRejectedValue(new Error("network"));

		expect(await proCreditPayer(seated)).toEqual({
			state: "refused",
			message:
				"Could not check your Cap Pro subscription. Try again in a moment.",
		});
	});

	it("does not ask Stripe on a self-hosted install", async () => {
		mocks.isCap = false;

		expect(await proCreditPayer(member())).toEqual({
			state: "ok",
			subscription: null,
		});
		expect(mocks.retrieve).not.toHaveBeenCalled();
	});
});
