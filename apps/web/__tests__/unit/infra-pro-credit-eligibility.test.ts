import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Subscriber = {
	id: string;
	email: string;
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

const mocks = vi.hoisted(() => ({
	isCap: true,
	user: null as Subscriber | null,
	claimedThisMonth: false,
	claim: vi.fn(),
	hasClaimed: vi.fn(),
	payer: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));
vi.mock("@cap/database", () => ({
	db: () => {
		const chain = {
			select: () => chain,
			from: () => chain,
			innerJoin: () => chain,
			where: () => chain,
			limit: async () => [{ id: "account-1" }],
		};
		return chain;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/infra-pro-credit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-pro-credit")>()),
	claimProMonthlyCredit: mocks.claim,
	hasClaimedProCredit: mocks.hasClaimed,
	nextProCreditDate: () => new Date("2026-12-01T00:00:00Z"),
	proCreditPayer: mocks.payer,
}));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => null }),
	headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({
	redirect: (path: string) => {
		throw new Error(`redirect:${path}`);
	},
	notFound: () => {
		throw new Error("not-found");
	},
	useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: ReactNode }) =>
		createElement("a", { href }, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/EffectRuntime", () => ({
	useEffectMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

const { PRO_CREDIT_TRIAL_MESSAGE, proCreditEligibility } = await import(
	"@/lib/infra-pro-credit-eligibility"
);
const { claimDeveloperProCredit } = await import(
	"@/actions/developers/claim-pro-credit"
);
const { getInfraProCredit } = await import(
	"@/app/(infra)/dashboard/infra/infra-data"
);
const { ProCredit } = await import(
	"@/app/(infra)/dashboard/infra/_components/pro-credit"
);
const { FirstCredit } = await import(
	"@/app/(infra)/dashboard/infra/_components/get-started"
);

const subscriber = (fields: Partial<Subscriber>): Subscriber => ({
	id: "user-1",
	email: "owner@example.com",
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
	...fields,
});

const PAID: Array<[string, Partial<Subscriber>]> = [
	["active", { stripeSubscriptionStatus: "active" }],
	["past_due", { stripeSubscriptionStatus: "past_due" }],
	["complete", { stripeSubscriptionStatus: "complete" }],
	["paid", { stripeSubscriptionStatus: "paid" }],
	["third-party", { thirdPartyStripeSubscriptionId: "sub_org" }],
	[
		"third-party beside a personal trial",
		{
			stripeSubscriptionStatus: "trialing",
			thirdPartyStripeSubscriptionId: "sub_org",
		},
	],
];

beforeEach(() => {
	mocks.isCap = true;
	mocks.user = null;
	mocks.claim.mockReset();
	mocks.claim.mockResolvedValue({
		claimed: true,
		balanceMicroCredits: 500_000,
	});
	mocks.payer.mockReset();
	mocks.payer.mockResolvedValue({
		state: "ok",
		subscription: { id: "sub_paying", seats: 2 },
	});
	mocks.hasClaimed.mockReset();
	mocks.hasClaimed.mockResolvedValue(false);
});

describe("who the Cap Pro credit is for", () => {
	it("is not for a trial", () => {
		expect(
			proCreditEligibility(
				subscriber({ stripeSubscriptionStatus: "trialing" }),
			),
		).toBe("trial");
	});

	it.each(PAID)("is for a %s subscription", (_label, fields) => {
		expect(proCreditEligibility(subscriber(fields))).toBe("paid");
	});

	it.each([null, "canceled", "unpaid", "incomplete"])(
		"is not for an account without Cap Pro (%s)",
		(status) => {
			expect(
				proCreditEligibility(subscriber({ stripeSubscriptionStatus: status })),
			).toBe("not_pro");
			expect(proCreditEligibility(null)).toBe("not_pro");
		},
	);

	it("stays open on a self-hosted install, where everyone has Pro", () => {
		mocks.isCap = false;
		expect(proCreditEligibility(subscriber({}))).toBe("paid");
	});

	it("says when the credit starts in one sentence", () => {
		expect(PRO_CREDIT_TRIAL_MESSAGE).toBe(
			"Your $5 monthly Infra credit starts with your first paid month of Cap Pro.",
		);
	});
});

describe("claiming the Cap Pro credit", () => {
	it("refuses a trialing account and grants nothing", async () => {
		mocks.user = subscriber({ stripeSubscriptionStatus: "trialing" });

		expect(await claimDeveloperProCredit("app-1")).toEqual({
			success: false,
			message: PRO_CREDIT_TRIAL_MESSAGE,
		});
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("refuses an account without Cap Pro", async () => {
		mocks.user = subscriber({ stripeSubscriptionStatus: "canceled" });

		expect(await claimDeveloperProCredit("app-1")).toEqual({
			success: false,
			message: "This credit comes with Cap Pro.",
		});
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it.each(PAID)("grants a %s subscription", async (_label, fields) => {
		mocks.user = subscriber(fields);

		expect(await claimDeveloperProCredit("app-1")).toEqual({
			balanceMicroCredits: 500_000,
		});
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				accountId: "account-1",
				subscription: { id: "sub_paying", seats: 2 },
			}),
		);
	});

	it("refuses a seat whose team subscription is not paid, and grants nothing", async () => {
		mocks.user = subscriber({ thirdPartyStripeSubscriptionId: "sub_org" });
		mocks.payer.mockResolvedValue({
			state: "refused",
			message: PRO_CREDIT_TRIAL_MESSAGE,
		});

		expect(await claimDeveloperProCredit("app-1")).toEqual({
			success: false,
			message: PRO_CREDIT_TRIAL_MESSAGE,
		});
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it("still refuses a second claim in the same month", async () => {
		mocks.user = subscriber({ stripeSubscriptionStatus: "active" });
		mocks.claim.mockResolvedValue({ claimed: false });

		expect(await claimDeveloperProCredit("app-1")).toEqual({
			success: false,
			message:
				"This month's credit is already claimed. It is one per account, not one per app.",
		});
	});
});

describe("what the console offers", () => {
	it("does not offer the claim to a trialing account", async () => {
		mocks.user = subscriber({ stripeSubscriptionStatus: "trialing" });

		expect(await getInfraProCredit()).toEqual({
			status: "trial",
			nextDate: "2026-12-01T00:00:00.000Z",
		});
		expect(mocks.hasClaimed).not.toHaveBeenCalled();
	});

	it.each(PAID)(
		"offers the claim to a %s subscription",
		async (_label, fields) => {
			mocks.user = subscriber(fields);

			expect((await getInfraProCredit()).status).toBe("available");
			mocks.hasClaimed.mockResolvedValue(true);
			expect((await getInfraProCredit()).status).toBe("claimed");
		},
	);

	it("keeps the upgrade note for an account without Cap Pro", async () => {
		mocks.user = subscriber({});

		expect((await getInfraProCredit()).status).toBe("not_pro");
	});

	const billingNote = (status: "available" | "claimed" | "trial" | "not_pro") =>
		renderToStaticMarkup(
			createElement(ProCredit, {
				appId: "app-1",
				credit: { status, nextDate: "2026-12-01T00:00:00.000Z" },
			}),
		);

	it("shows a trial one sentence and no claim button", () => {
		const html = billingNote("trial");

		expect(html).toBe(
			`<p class="${/class="([^"]+)"/.exec(html)?.[1]}">${PRO_CREDIT_TRIAL_MESSAGE}</p>`,
		);
		expect(html).not.toContain("<button");
		expect(html).not.toContain("Claim");
		expect(html).not.toContain(String.fromCodePoint(0x2014));
		expect(html).not.toContain("uppercase");
	});

	it("still shows the claim button to a paid account", () => {
		expect(billingNote("available")).toContain("Claim $5 credit");
		expect(billingNote("claimed")).not.toContain("<button");
		expect(billingNote("not_pro")).toContain("See Cap Pro");
	});

	it("sends a trial with no balance to add credits instead of a claim", () => {
		const html = renderToStaticMarkup(
			createElement(FirstCredit, {
				appId: "app-1",
				balanceMicroCredits: 0,
				proCredit: { status: "trial", nextDate: "2026-12-01T00:00:00.000Z" },
			}),
		);

		expect(html).toContain("Add credits");
		expect(html).toContain(PRO_CREDIT_TRIAL_MESSAGE);
		expect(html).not.toContain("Claim");
	});
});
