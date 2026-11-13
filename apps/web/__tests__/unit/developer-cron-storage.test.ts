import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as Record<string, unknown>[][],
	page: [] as Record<string, unknown>[],
	accountsTable: { id: "id", appId: "appId" },
	appsTable: { id: "id", deletedAt: "deletedAt" },
	ledgerTable: {
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
	snapshotsTable: { appId: "appId", snapshotDate: "snapshotDate" },
	yesterdayBilled: null as Record<string, unknown>[] | null,
	markers: [] as unknown[],
	getStorageUsageByApp: vi.fn(),
	chargeMissedFirstMonths: vi.fn(),
	shortfallsAwaitingNotice: vi.fn(),
	openFirstMonthShortfalls: vi.fn(),
	markShortfallsNotified: vi.fn(),
	markStorageDayNotified: vi.fn(),
	chargeStorageDay: vi.fn(),
	latestStorageCharge: vi.fn(),
	latestStorageCharges: vi.fn(),
	restoredSinceCharge: vi.fn(),
	runDueAutoTopUps: vi.fn(),
	sendInfraOutOfCreditEmail: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		let table: unknown;
		const dateOf = (condition: unknown) => {
			const match = JSON.stringify(condition).match(
				/\{"eq":\["referenceId","(\d{4}-\d{2}-\d{2})"\]\}/,
			);
			return match?.[1] ?? null;
		};
		const read = (condition: unknown) => {
			if (table === mocks.appsTable) {
				return mocks.page.map((account) => ({ id: account.appId }));
			}
			if (table === mocks.accountsTable) {
				mocks.page = mocks.selects[0] ?? [];
				return mocks.page;
			}
			if (table === mocks.ledgerTable) {
				if (dateOf(condition) === new Date().toISOString().slice(0, 10)) {
					return mocks.selects[1] ?? [];
				}
				return (
					mocks.yesterdayBilled ??
					mocks.page.map((account) => ({ accountId: account.id }))
				);
			}
			return [];
		};
		const chain = {
			select: () => chain,
			from: (next: unknown) => {
				table = next;
				return chain;
			},
			where: (condition: unknown) => {
				const rows = Promise.resolve(read(condition));
				return Object.assign(rows, {
					orderBy: () => ({ limit: () => rows }),
				});
			},
		};
		return chain;
	},
}));
vi.mock("@cap/database/schema", () => ({
	developerApps: mocks.appsTable,
	developerCreditAccounts: mocks.accountsTable,
	developerCreditTransactions: mocks.ledgerTable,
	developerDailyStorageSnapshots: mocks.snapshotsTable,
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	asc: (a: unknown) => ({ asc: a }),
	gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
	eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
	inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
	isNull: (a: unknown) => ({ isNull: a }),
	isNotNull: (a: unknown) => ({ isNotNull: a }),
}));
vi.mock("@/lib/infra-storage", () => ({
	getStorageUsageByApp: mocks.getStorageUsageByApp,
}));
vi.mock("@/lib/infra-storage-minimum", () => ({
	chargeMissedFirstMonths: mocks.chargeMissedFirstMonths,
	shortfallsAwaitingNotice: mocks.shortfallsAwaitingNotice,
	openFirstMonthShortfalls: mocks.openFirstMonthShortfalls,
	markShortfallsNotified: mocks.markShortfallsNotified,
	markStorageDayNotified: mocks.markStorageDayNotified,
}));
vi.mock("@/lib/infra-storage-billing", () => ({
	chargeStorageDay: mocks.chargeStorageDay,
	recordStorageDayVisits: async ({ appIds }: { appIds: string[] }) => {
		mocks.markers.push(...appIds);
	},
}));
vi.mock("@/lib/infra-standing", () => ({
	INFRA_GRACE_DAYS: 7,
	STORAGE_DAY_REFERENCE_TYPE: "storage_day",
	latestStorageCharge: mocks.latestStorageCharge,
	latestStorageCharges: mocks.latestStorageCharges,
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
	mocks.page = [];
	mocks.yesterdayBilled = null;
	mocks.markers = [];
	for (const mock of [
		mocks.getStorageUsageByApp,
		mocks.chargeStorageDay,
		mocks.latestStorageCharges,
		mocks.runDueAutoTopUps,
		mocks.sendInfraOutOfCreditEmail,
	]) {
		mock.mockReset();
	}
	mocks.chargeMissedFirstMonths.mockReset();
	mocks.chargeMissedFirstMonths.mockResolvedValue(NO_FIRST_MONTHS);
	mocks.shortfallsAwaitingNotice.mockReset();
	mocks.shortfallsAwaitingNotice.mockResolvedValue(new Map());
	mocks.markShortfallsNotified.mockReset();
	mocks.markStorageDayNotified.mockReset();
	mocks.openFirstMonthShortfalls.mockReset();
	mocks.openFirstMonthShortfalls.mockResolvedValue(new Set());
	mocks.restoredSinceCharge.mockReset();
	mocks.restoredSinceCharge.mockResolvedValue(false);
	mocks.runDueAutoTopUps.mockResolvedValue(NO_TOP_UPS);
	mocks.latestStorageCharges.mockResolvedValue(new Map());
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
		expect(mocks.markers).toEqual(["app-1"]);
	});

	it("looks up the last charge of every idle account in one read", async () => {
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
				["app-2", usage(28)],
				["app-3", usage(0)],
			]),
		);

		const { body } = await authorized();

		expect(body).toMatchObject({ complete: true, appsProcessed: 1 });
		expect(mocks.latestStorageCharges).toHaveBeenCalledTimes(1);
		expect(mocks.latestStorageCharges).toHaveBeenCalledWith(expect.anything(), [
			"account-1",
			"account-3",
		]);
	});

	it("still settles an app that stores nothing now but is short from before", async () => {
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);
		mocks.latestStorageCharges.mockResolvedValue(
			new Map([
				[
					"account-1",
					{
						createdAt: new Date(),
						owedMicroCredits: 28,
						shortSince: new Date(),
					},
				],
			]),
		);

		await authorized();

		expect(mocks.latestStorageCharges).toHaveBeenCalledWith(expect.anything(), [
			"account-1",
		]);
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

	it("opens the day's charge for a short first month even when nothing is charged daily, so a recovery can be recorded", async () => {
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);
		mocks.openFirstMonthShortfalls.mockResolvedValue(new Set(["account-1"]));

		await authorized();

		expect(mocks.openFirstMonthShortfalls).toHaveBeenCalledWith(["account-1"]);
		expect(mocks.chargeStorageDay).toHaveBeenCalledTimes(1);
		expect(mocks.chargeStorageDay.mock.calls[0]?.[0]).toMatchObject({
			accountId: "account-1",
			measure: expect.any(Function),
		});
	});

	it("emails a new first month shortfall once, like a daily one, with the pause date seven days after it began", async () => {
		const shortSince = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		const accounts = () => [
			[
				{ id: "account-1", appId: "app-1" },
				{ id: "account-2", appId: "app-2" },
				{ id: "account-3", appId: "app-3" },
			],
			[],
		];
		mocks.selects = accounts();
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([
				["app-1", usage(0)],
				["app-2", usage(0)],
				["app-3", usage(0)],
			]),
		);
		mocks.shortfallsAwaitingNotice.mockResolvedValueOnce(
			new Map([
				["account-2", { shortSince, ids: ["row-2"] }],
				["account-3", { shortSince, ids: ["row-3"] }],
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
		mocks.sendInfraOutOfCreditEmail.mockResolvedValue(true);

		const before = Date.now();
		await authorized();

		const [accountIds, since] =
			mocks.shortfallsAwaitingNotice.mock.calls[0] ?? [];
		expect(accountIds).toEqual(["account-1", "account-2", "account-3"]);
		expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(
			7 * 24 * 60 * 60 * 1000 - 1000,
		);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledWith({
			accountId: "account-2",
			shortSince,
			pausesAt: new Date(shortSince.getTime() + 7 * 24 * 60 * 60 * 1000),
		});
		expect(mocks.markShortfallsNotified.mock.calls.map(([ids]) => ids)).toEqual(
			[["row-2"], ["row-3"]],
		);

		mocks.selects = accounts();
		await authorized();
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
	});

	it("stamps a daily shortfall's row once its email was accepted, and leaves a rejected one for the next run", async () => {
		const shortSince = new Date("2026-11-11T06:41:00Z");
		const run = async (sent: boolean) => {
			mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
			mocks.getStorageUsageByApp.mockResolvedValue(
				new Map([["app-1", usage(28)]]),
			);
			mocks.chargeStorageDay.mockResolvedValueOnce(
				billed({ chargedMicroCredits: 5, shortSince, fellShort: true }),
			);
			mocks.sendInfraOutOfCreditEmail.mockResolvedValueOnce(sent);
			return authorized();
		};

		const { body } = await run(false);
		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
		expect(mocks.markStorageDayNotified).not.toHaveBeenCalled();

		await run(true);
		expect(mocks.markStorageDayNotified).toHaveBeenCalledWith(
			"account-1",
			body.date,
			expect.any(Date),
		);
	});

	it("keeps a first month shortfall to email again when the email could not be sent", async () => {
		const shortSince = new Date();
		mocks.selects = [[{ id: "account-1", appId: "app-1" }], []];
		mocks.getStorageUsageByApp.mockResolvedValue(
			new Map([["app-1", usage(0)]]),
		);
		mocks.shortfallsAwaitingNotice.mockResolvedValueOnce(
			new Map([["account-1", { shortSince, ids: ["row-1"] }]]),
		);
		mocks.latestStorageCharge.mockResolvedValue({
			createdAt: shortSince,
			owedMicroCredits: 850,
			shortSince,
			firstMonth: true,
		});
		mocks.restoredSinceCharge.mockResolvedValue(false);
		mocks.sendInfraOutOfCreditEmail.mockResolvedValue(false);

		await authorized();

		expect(mocks.sendInfraOutOfCreditEmail).toHaveBeenCalledTimes(1);
		expect(mocks.markShortfallsNotified).not.toHaveBeenCalled();
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
