import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as Record<string, unknown>[][],
	getStorageUsageByApp: vi.fn(),
	chargeMissedFirstMonths: vi.fn(),
	firstMonthShortfallsSince: vi.fn(),
	chargeStorageDay: vi.fn(),
	latestStorageCharge: vi.fn(),
	restoredSinceCharge: vi.fn(),
	runDueAutoTopUps: vi.fn(),
	sendInfraOutOfCreditEmail: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		const chain = {
			select: () => chain,
			from: () => chain,
			innerJoin: () => chain,
			where: async () => mocks.selects.shift() ?? [],
		};
		return chain;
	},
}));
vi.mock("@cap/database/schema", () => ({
	developerApps: { id: "id", deletedAt: "deletedAt" },
	developerCreditAccounts: { id: "id", appId: "appId" },
	developerCreditTransactions: {
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
	inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
	isNull: (a: unknown) => ({ isNull: a }),
}));
vi.mock("@/lib/infra-storage", () => ({
	getStorageUsageByApp: mocks.getStorageUsageByApp,
}));
vi.mock("@/lib/infra-storage-minimum", () => ({
	chargeMissedFirstMonths: mocks.chargeMissedFirstMonths,
	firstMonthShortfallsSince: mocks.firstMonthShortfallsSince,
}));
vi.mock("@/lib/infra-storage-billing", () => ({
	chargeStorageDay: mocks.chargeStorageDay,
}));
vi.mock("@/lib/infra-standing", () => ({
	INFRA_GRACE_DAYS: 7,
	STORAGE_DAY_REFERENCE_TYPE: "storage_day",
	latestStorageCharge: mocks.latestStorageCharge,
	restoredSinceCharge: mocks.restoredSinceCharge,
}));
vi.mock("@/lib/infra-auto-top-up", () => ({
	runDueAutoTopUps: mocks.runDueAutoTopUps,
}));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraOutOfCreditEmail: mocks.sendInfraOutOfCreditEmail,
}));

import { GET } from "@/app/api/cron/developer-storage/route";

const CRON_SECRET = "test-cron-secret";
const NO_TOP_UPS = { attempted: 0, succeeded: 0, failed: 0 };
const NO_FIRST_MONTHS = { charged: 0, short: 0, failed: 0 };

const usage = (dailyMicroCredits: number) => ({
	videoCount: dailyMicroCredits > 0 ? 1 : 0,
	totalMinutes: dailyMicroCredits > 0 ? 10 : 0,
	minutesByTier: { "1080p": 10, "1440p": 0, "2160p": 0 },
	monthlyMicroCredits: dailyMicroCredits * 30,
	dailyMicroCredits,
});

const billed = (extra: Record<string, unknown> = {}) => ({
	state: "billed",
	owedMicroCredits: 28,
	chargedMicroCredits: 28,
	balanceMicroCredits: 972,
	shortSince: null,
	fellShort: false,
	...extra,
});

const run = async (authorization?: string) => {
	const response = await GET(
		new Request("https://localhost/api/cron/developer-storage", {
			headers: authorization ? { authorization } : {},
		}),
	);
	return { status: response.status, body: await response.json() };
};

const authorized = () => run(`Bearer ${CRON_SECRET}`);

beforeEach(() => {
	process.env.CRON_SECRET = CRON_SECRET;
	mocks.selects = [];
	for (const mock of [
		mocks.getStorageUsageByApp,
		mocks.chargeStorageDay,
		mocks.latestStorageCharge,
		mocks.runDueAutoTopUps,
		mocks.sendInfraOutOfCreditEmail,
	]) {
		mock.mockReset();
	}
	mocks.chargeMissedFirstMonths.mockReset();
	mocks.chargeMissedFirstMonths.mockResolvedValue(NO_FIRST_MONTHS);
	mocks.firstMonthShortfallsSince.mockReset();
	mocks.firstMonthShortfallsSince.mockResolvedValue(new Map());
	mocks.restoredSinceCharge.mockReset();
	mocks.restoredSinceCharge.mockResolvedValue(false);
	mocks.runDueAutoTopUps.mockResolvedValue(NO_TOP_UPS);
	mocks.latestStorageCharge.mockResolvedValue(null);
	mocks.chargeStorageDay.mockResolvedValue(billed());
});

describe("developer-storage cron job", () => {
	it("refuses a request with no or the wrong bearer token, before touching anything", async () => {
		expect(await run()).toEqual({
			status: 401,
			body: { error: "Unauthorized" },
		});
		expect(await run("Bearer wrong-secret")).toMatchObject({ status: 401 });
		expect(mocks.chargeStorageDay).not.toHaveBeenCalled();
		expect(mocks.runDueAutoTopUps).not.toHaveBeenCalled();
	});

	it("fails closed when the secret is not configured", async () => {
		delete process.env.CRON_SECRET;

		expect(await run("Bearer undefined")).toMatchObject({ status: 500 });
		expect(mocks.chargeStorageDay).not.toHaveBeenCalled();
	});

	it("charges each app that stores video and reports the day", async () => {
		mocks.selects = [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
			],
			[],
		];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([
				["app-1", usage(28)],
				["app-2", usage(144)],
			]),
		);

		const { status, body } = await authorized();

		expect(status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			appsProcessed: 2,
			appsShort: 0,
			autoTopUps: NO_TOP_UPS,
		});
		expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(mocks.getStorageUsageByApp.mock.calls[0]?.[0]).toEqual([
			"app-1",
			"app-2",
		]);
		expect(mocks.chargeStorageDay).toHaveBeenCalledTimes(2);
		expect(mocks.chargeStorageDay).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: "app-2",
				accountId: "account-2",
				usage: usage(144),
				dateKey: body.date,
			}),
		);
		const measured = new Map([["app-2", usage(56)]]);
		mocks.getStorageUsageByApp.mockResolvedValueOnce(measured);
		const tx = { lock: "held" };
		const [{ measure }] = mocks.chargeStorageDay.mock.calls[1] ?? [{}];
		expect(await measure(tx)).toEqual(usage(56));
		expect(mocks.getStorageUsageByApp).toHaveBeenLastCalledWith(
			["app-2"],
			undefined,
			tx,
			{ dailyChargeAt: expect.any(Date) },
		);
	});

	it("skips accounts already billed today", async () => {
		mocks.selects = [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
			],
			[{ accountId: "account-1" }],
		];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-2", usage(28)]]),
		);

		const { body } = await authorized();

		expect(body.appsProcessed).toBe(1);
		expect(mocks.getStorageUsageByApp.mock.calls[0]?.[0]).toEqual(["app-2"]);
		expect(mocks.chargeStorageDay).toHaveBeenCalledTimes(1);
		expect(mocks.chargeStorageDay.mock.calls[0]?.[0]).toMatchObject({
			accountId: "account-2",
		});
	});

	it("does not open a charge for an app that stores nothing and owes nothing", async () => {
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);

		const { body } = await authorized();

		expect(body.appsProcessed).toBe(0);
		expect(mocks.chargeStorageDay).not.toHaveBeenCalled();
	});

	it("still settles an app that stores nothing now but is short from before", async () => {
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);
		mocks.latestStorageCharge.mockResolvedValue({
			createdAt: new Date(),
			owedMicroCredits: 28,
			shortSince: new Date(),
		});

		await authorized();

		expect(mocks.chargeStorageDay).toHaveBeenCalledTimes(1);
	});

	it("emails once when an app first falls short, with the pause date seven days on", async () => {
		const shortSince = new Date("2026-11-11T06:41:00Z");
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(28)]]),
		);
		mocks.chargeStorageDay.mockResolvedValue(
			billed({ chargedMicroCredits: 5, shortSince, fellShort: true }),
		);

		const { body } = await authorized();

		expect(body).toMatchObject({ appsProcessed: 1, appsShort: 1 });
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledWith({
			accountId: "account-1",
			shortSince,
			pausesAt: new Date("2026-11-18T06:41:00Z"),
		});
	});

	it("does not email again on later short or unpaid days", async () => {
		mocks.selects = [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
			],
			[],
		];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([
				["app-1", usage(28)],
				["app-2", usage(28)],
			]),
		);
		mocks.chargeStorageDay
			.mockResolvedValueOnce(
				billed({ chargedMicroCredits: 5, shortSince: new Date() }),
			)
			.mockResolvedValueOnce({ state: "unpaid", shortSince: new Date() });

		const { body } = await authorized();

		expect(body).toMatchObject({ appsProcessed: 1, appsShort: 2 });
		expect(mocks.sendInfraOutOfCreditEmail).not.toHaveBeenCalled();
	});

	it("keeps going when one app fails", async () => {
		mocks.selects = [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
			],
			[],
		];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([
				["app-1", usage(28)],
				["app-2", usage(28)],
			]),
		);
		mocks.chargeStorageDay
			.mockRejectedValueOnce(new Error("deadlock"))
			.mockResolvedValueOnce(billed());
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const { status, body } = await authorized();

		expect(status).toBe(200);
		expect(body.appsProcessed).toBe(1);
		expect(mocks.runDueAutoTopUps).toHaveBeenCalledTimes(2);
		errors.mockRestore();
	});

	it("runs auto top-ups before and after the day's charges and adds up the report", async () => {
		const order: string[] = [];
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(28)]]),
		);
		mocks.chargeStorageDay.mockImplementation(async () => {
			order.push("charge");
			return billed();
		});
		mocks.runDueAutoTopUps
			.mockImplementationOnce(async () => {
				order.push("top-up");
				return { attempted: 2, succeeded: 1, failed: 1 };
			})
			.mockImplementationOnce(async () => {
				order.push("top-up");
				return { attempted: 1, succeeded: 1, failed: 0 };
			});

		const { body } = await authorized();

		expect(order).toEqual(["top-up", "charge", "top-up"]);
		expect(body.autoTopUps).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
	});

	it("charges missed first months after the first top-ups and before the day is measured", async () => {
		const order: string[] = [];
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.runDueAutoTopUps.mockImplementation(async () => {
			order.push("top-up");
			return NO_TOP_UPS;
		});
		mocks.chargeMissedFirstMonths.mockImplementation(async () => {
			order.push("first months");
			return { charged: 2, short: 1, failed: 0 };
		});
		mocks.getStorageUsageByApp.mockImplementation(async () => {
			order.push("measure");
			return new Map([["app-1", usage(28)]]);
		});

		const { body } = await authorized();

		expect(order).toEqual(["top-up", "first months", "measure", "top-up"]);
		expect(body.firstMonths).toEqual({ charged: 2, short: 1, failed: 0 });
	});

	it("does not open a daily charge to settle a short first month when nothing is charged daily", async () => {
		const shortSince = new Date(Date.now() - 60 * 60 * 1000);
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);
		mocks.latestStorageCharge.mockResolvedValue({
			createdAt: shortSince,
			owedMicroCredits: 5_600,
			shortSince,
			firstMonth: true,
		});

		await authorized();

		expect(mocks.chargeStorageDay).not.toHaveBeenCalled();
	});

	it("emails an account whose first month fell short in the last day and is still short, with the pause date seven days on", async () => {
		const shortSince = new Date(Date.now() - 20 * 60 * 60 * 1000);
		mocks.selects = [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
				{ id: "account-3", appId: "app-3" },
			],
			[],
		];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([
				["app-1", usage(0)],
				["app-2", usage(0)],
				["app-3", usage(0)],
			]),
		);
		mocks.firstMonthShortfallsSince.mockResolvedValue(
			new Map([
				["account-2", shortSince],
				["account-3", shortSince],
			]),
		);
		const short = {
			createdAt: shortSince,
			owedMicroCredits: 850,
			shortSince,
			firstMonth: true,
		};
		mocks.latestStorageCharge.mockImplementation(
			async (_db: unknown, accountId: string) =>
				accountId === "account-1" ? null : short,
		);
		mocks.restoredSinceCharge.mockImplementation(
			async (_db: unknown, accountId: string) => accountId === "account-3",
		);

		const before = Date.now();
		await authorized();

		const [accountIds, since] =
			mocks.firstMonthShortfallsSince.mock.calls[0] ?? [];
		expect(accountIds).toEqual(["account-1", "account-2", "account-3"]);
		expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(
			24 * 60 * 60 * 1000 - 1000,
		);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledWith({
			accountId: "account-2",
			shortSince,
			pausesAt: new Date(shortSince.getTime() + 7 * 24 * 60 * 60 * 1000),
		});
	});

	it("answers with zero apps when there are none", async () => {
		const { body } = await authorized();

		expect(body).toMatchObject({
			success: true,
			appsProcessed: 0,
			appsShort: 0,
		});
		expect(mocks.getStorageUsageByApp).not.toHaveBeenCalled();
	});
});
