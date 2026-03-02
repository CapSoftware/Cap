import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "test-nano-id"),
}));

vi.mock("@cap/database/schema", () => ({
	developerApps: { id: "id", deletedAt: "deletedAt" },
	developerCreditAccounts: {
		id: "id",
		appId: "appId",
		balanceMicroCredits: "balanceMicroCredits",
	},
	developerCreditTransactions: {},
	developerDailyStorageSnapshots: {
		appId: "appId",
		snapshotDate: "snapshotDate",
		id: "id",
		processedAt: "processedAt",
	},
	developerVideos: {
		appId: "appId",
		deletedAt: "deletedAt",
		duration: "duration",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: any[]) => args),
	eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
	isNull: vi.fn((a: any) => ({ isNull: a })),
	sql: vi.fn(),
}));

let capturedJsonBody: any = null;
let capturedStatus: number | undefined = undefined;

vi.mock("next/server", () => ({
	NextResponse: {
		json: vi.fn((body: any, init?: any) => {
			capturedJsonBody = body;
			capturedStatus = init?.status;
			return { body, status: init?.status ?? 200 };
		}),
	},
}));

const CRON_SECRET = "test-cron-secret";

function makeChain(
	result: any[],
	options?: { onTransaction?: (tx: any) => void },
) {
	const chain: any = {
		select: vi.fn(() => chain),
		from: vi.fn(() => chain),
		where: vi.fn(() => chain),
		limit: vi.fn(() => Promise.resolve(result)),
		insert: vi.fn(() => chain),
		values: vi.fn(() => Promise.resolve()),
		update: vi.fn(() => chain),
		set: vi.fn(() => chain),
		transaction: vi.fn(async (cb: any) => {
			const txChain: any = {
				select: vi.fn(() => txChain),
				from: vi.fn(() => txChain),
				where: vi.fn(() => txChain),
				limit: vi.fn(() =>
					Promise.resolve([{ balanceMicroCredits: 0 }]),
				),
				insert: vi.fn(() => txChain),
				values: vi.fn(() => Promise.resolve()),
				update: vi.fn(() => txChain),
				set: vi.fn(() => txChain),
			};
			if (options?.onTransaction) {
				options.onTransaction(txChain);
			}
			await cb(txChain);
		}),
	};
	chain.then = (resolve: any) => resolve(result);
	return chain;
}

function setupDbSequence(
	responses: any[][],
	txOptions?: { onTransaction?: (tx: any) => void },
) {
	let callIndex = 0;
	mockDb.mockImplementation(() => {
		const idx = callIndex++;
		const result = idx < responses.length ? responses[idx] : [];
		return makeChain(result, txOptions);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	capturedJsonBody = null;
	capturedStatus = undefined;
	process.env.CRON_SECRET = CRON_SECRET;
});

async function importGET() {
	const mod = await import("@/app/api/cron/developer-storage/route");
	return mod.GET;
}

function makeRequest(authHeader?: string): Request {
	const headers = new Headers();
	if (authHeader) {
		headers.set("authorization", authHeader);
	}
	return new Request("https://localhost/api/cron/developer-storage", {
		method: "GET",
		headers,
	});
}

describe("developer-storage cron job", () => {
	describe("authentication", () => {
		it("returns 401 when no auth header", async () => {
			const GET = await importGET();
			await GET(makeRequest());

			expect(capturedJsonBody).toEqual({ error: "Unauthorized" });
			expect(capturedStatus).toBe(401);
		});

		it("returns 401 when wrong bearer token", async () => {
			const GET = await importGET();
			await GET(makeRequest("Bearer wrong-secret"));

			expect(capturedJsonBody).toEqual({ error: "Unauthorized" });
			expect(capturedStatus).toBe(401);
		});
	});

	describe("processing apps", () => {
		it("processes apps with videos and charges correctly", async () => {
			const GET = await importGET();

			setupDbSequence([
				[{ id: "app-1" }],
				[],
				[{ totalDurationMinutes: 10, videoCount: 5 }],
				[{ id: "account-1", appId: "app-1", balanceMicroCredits: 1000 }],
				[],
			]);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedJsonBody).toMatchObject({
				success: true,
				appsProcessed: 1,
			});
			expect(capturedJsonBody.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("skips already-processed apps", async () => {
			const GET = await importGET();

			setupDbSequence([
				[{ id: "app-1" }],
				[{ id: "snapshot-1", processedAt: new Date() }],
			]);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedJsonBody).toMatchObject({
				success: true,
				appsProcessed: 0,
			});
		});

		it("skips apps with 0 total duration", async () => {
			const GET = await importGET();

			setupDbSequence([
				[{ id: "app-1" }],
				[],
				[{ totalDurationMinutes: 0, videoCount: 0 }],
			]);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedJsonBody).toMatchObject({
				success: true,
				appsProcessed: 0,
			});
		});

		it("skips apps with no credit account", async () => {
			const GET = await importGET();

			setupDbSequence([
				[{ id: "app-1" }],
				[],
				[{ totalDurationMinutes: 10, videoCount: 5 }],
				[],
			]);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedJsonBody).toMatchObject({
				success: true,
				appsProcessed: 0,
			});
		});
	});

	describe("transaction behavior", () => {
		it("creates negative transaction for storage_daily", async () => {
			const GET = await importGET();
			let insertValues: any = null;

			setupDbSequence(
				[
					[{ id: "app-1" }],
					[],
					[{ totalDurationMinutes: 10, videoCount: 5 }],
					[{ id: "account-1", appId: "app-1", balanceMicroCredits: 1000 }],
					[],
				],
				{
					onTransaction: (tx) => {
						tx.values.mockImplementation((vals: any) => {
							if (vals?.type === "storage_daily") {
								insertValues = vals;
							}
							return Promise.resolve();
						});
					},
				},
			);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(insertValues).not.toBeNull();
			expect(insertValues.type).toBe("storage_daily");
			expect(insertValues.amountMicroCredits).toBe(-33);
		});

		it("transaction amount is negative (debit)", async () => {
			const GET = await importGET();
			let capturedAmount: number | null = null;

			setupDbSequence(
				[
					[{ id: "app-1" }],
					[],
					[{ totalDurationMinutes: 10, videoCount: 3 }],
					[{ id: "account-1", appId: "app-1", balanceMicroCredits: 500 }],
					[],
				],
				{
					onTransaction: (tx) => {
						tx.values.mockImplementation((vals: any) => {
							if (vals?.type === "storage_daily") {
								capturedAmount = vals.amountMicroCredits;
							}
							return Promise.resolve();
						});
					},
				},
			);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedAmount).toBeLessThan(0);
		});
	});

	describe("response format", () => {
		it("returns correct response format", async () => {
			const GET = await importGET();

			setupDbSequence([[]]);

			await GET(makeRequest(`Bearer ${CRON_SECRET}`));

			expect(capturedJsonBody).toHaveProperty("success", true);
			expect(capturedJsonBody).toHaveProperty("date");
			expect(capturedJsonBody).toHaveProperty("appsProcessed");
			expect(capturedJsonBody.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(typeof capturedJsonBody.appsProcessed).toBe("number");
		});
	});

	describe("storage rate calculations", () => {
		const MICRO_CREDITS_PER_MINUTE_PER_DAY = 3.33;

		it("1 minute -> 3 credits", () => {
			expect(Math.floor(1 * MICRO_CREDITS_PER_MINUTE_PER_DAY)).toBe(3);
		});

		it("10 minutes -> 33 credits", () => {
			expect(Math.floor(10 * MICRO_CREDITS_PER_MINUTE_PER_DAY)).toBe(33);
		});

		it("100 minutes -> 333 credits", () => {
			expect(Math.floor(100 * MICRO_CREDITS_PER_MINUTE_PER_DAY)).toBe(333);
		});

		it("1000 minutes -> 3330 credits", () => {
			expect(Math.floor(1000 * MICRO_CREDITS_PER_MINUTE_PER_DAY)).toBe(3330);
		});

		it("0.5 minutes -> 1 credit", () => {
			expect(Math.floor(0.5 * MICRO_CREDITS_PER_MINUTE_PER_DAY)).toBe(1);
		});
	});
});
