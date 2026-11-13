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
	getStorageUsageByApp: vi.fn(),
	chargeStorageDay: vi.fn(),
	latestStorageCharges: vi.fn(),
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
vi.mock("@/lib/infra-storage-billing", () => ({
	chargeStorageDay: mocks.chargeStorageDay,
}));
vi.mock("@/lib/infra-standing", () => ({
	INFRA_GRACE_DAYS: 7,
	STORAGE_DAY_REFERENCE_TYPE: "storage_day",
	latestStorageCharges: mocks.latestStorageCharges,
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
	for (const mock of [
		mocks.getStorageUsageByApp,
		mocks.chargeStorageDay,
		mocks.latestStorageCharges,
		mocks.runDueAutoTopUps,
		mocks.sendInfraOutOfCreditEmail,
	]) {
		mock.mockReset();
	}
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
		expect(mocks.getStorageUsageByApp).toHaveBeenCalledWith(["app-1", "app-2"]);
		expect(mocks.chargeStorageDay).toHaveBeenCalledTimes(2);
		expect(mocks.chargeStorageDay).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: "app-2",
				accountId: "account-2",
				usage: usage(144),
				dateKey: body.date,
			}),
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
		expect(mocks.getStorageUsageByApp).toHaveBeenCalledWith(["app-2"]);
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
