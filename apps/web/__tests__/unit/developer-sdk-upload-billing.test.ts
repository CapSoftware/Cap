import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const S3_KEY = "developer/app-1/video-1/video";
const FOUR_HOURS_SECS = 4 * 60 * 60;

type StoredPart = { PartNumber: number; ETag?: string; Size?: number };

const mocks = vi.hoisted(() => ({
	balance: 0,
	accountExists: true,
	storedParts: [] as StoredPart[],
	listPartsFails: false,
	completeFailures: 0,
	storedDuration: null as number | null,
	events: [] as string[],
	complete: vi.fn(),
	listParts: vi.fn(),
	creditTransactions: [] as Record<string, unknown>[],
	videoUpdates: [] as Record<string, unknown>[],
}));

vi.mock("@cap/database", async () => {
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const { developerVideos } = await import("@cap/database/schema");
	const dialect = new MySqlDialect();

	const selectRows = (fields: Record<string, unknown>) => {
		const keys = Object.keys(fields).sort().join(",");
		if (keys === "appId,deletedAt,duration,s3Key") {
			return [
				{
					appId: "app-1",
					s3Key: S3_KEY,
					duration: mocks.storedDuration,
					deletedAt: null,
				},
			];
		}
		if (keys === "id") {
			return [{ id: "video-1" }];
		}
		if (keys === "total") {
			return [
				{
					total: mocks.creditTransactions.reduce(
						(sum, row) => sum - Number(row.amountMicroCredits),
						0,
					),
				},
			];
		}
		if (keys === "balanceMicroCredits,id") {
			return mocks.accountExists
				? [{ id: "account-1", balanceMicroCredits: mocks.balance }]
				: [];
		}
		if (keys === "balanceMicroCredits") {
			return [{ balanceMicroCredits: mocks.balance }];
		}
		throw new Error(`Unexpected select: ${keys}`);
	};

	const selectChain = (fields: Record<string, unknown>) => ({
		from: () => ({
			where: () =>
				Object.assign(
					Promise.resolve().then(() => selectRows(fields)),
					{
						limit: async () => selectRows(fields),
						for: async () => selectRows(fields),
					},
				),
		}),
	});

	const tx = {
		select: selectChain,
		update: () => ({
			set: (values: {
				balanceMicroCredits: Parameters<typeof dialect.sqlToQuery>[0];
			}) => ({
				where: async () => {
					const debit = Number(
						dialect.sqlToQuery(values.balanceMicroCredits).params.at(-1),
					);
					if (mocks.balance < debit) return [{ affectedRows: 0 }];
					mocks.balance -= debit;
					mocks.events.push("debit");
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				mocks.creditTransactions.push(values);
			},
		}),
	};
	return {
		db: () => ({
			select: selectChain,
			transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
				callback(tx),
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						if (table !== developerVideos) return;
						mocks.videoUpdates.push(values);
						if (typeof values.duration === "number")
							mocks.storedDuration = values.duration;
					},
				}),
			}),
		}),
	};
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "transaction-1",
	nanoIdLength: 15,
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{
						multipart: {
							complete: mocks.complete,
							listParts: mocks.listParts,
						},
					},
				]),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown, unknown>) =>
			Effect.runPromise(effect),
	};
});

vi.mock("@/app/api/utils", () => ({
	withDeveloperPublicAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("developerAppId", "app-1");
		c.set("developerKeyType", "public");
		await next();
	},
}));

import { app } from "@/app/api/developer/sdk/v1/[...route]/upload";

type RequestPart = { partNumber: number; etag: string; size: number };

const complete = (body: { parts?: RequestPart[]; durationInSecs: number }) =>
	app.request("/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "video-1",
			uploadId: "upload-1",
			parts: body.parts ?? [{ partNumber: 1, etag: '"etag-1"', size: 1 }],
			durationInSecs: body.durationInSecs,
			width: 1920,
			height: 1080,
		}),
	});

const microCreditsFor = (seconds: number) => Math.floor((seconds / 60) * 5_000);

describe("developer SDK multipart completion billing", () => {
	beforeEach(() => {
		mocks.balance = 10_000_000;
		mocks.accountExists = true;
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 1_000 }];
		mocks.listPartsFails = false;
		mocks.completeFailures = 0;
		mocks.storedDuration = null;
		mocks.events = [];
		mocks.creditTransactions = [];
		mocks.videoUpdates = [];
		mocks.complete.mockReset();
		mocks.complete.mockImplementation(() => {
			if (mocks.completeFailures > 0) {
				mocks.completeFailures -= 1;
				return Effect.fail(new Error("complete failed"));
			}
			return Effect.sync(() => {
				mocks.events.push("complete");
				return {};
			});
		});
		mocks.listParts.mockReset();
		mocks.listParts.mockImplementation(() =>
			mocks.listPartsFails
				? Effect.fail(new Error("list failed"))
				: Effect.succeed(mocks.storedParts),
		);
	});

	it("bills from the part sizes storage reports, not the sizes in the request", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 60_000_000 },
			{ PartNumber: 2, ETag: '"etag-2"', Size: 40_000_000 },
		];
		const response = await complete({
			parts: [
				{ partNumber: 1, etag: '"etag-1"', size: 1 },
				{ partNumber: 2, etag: '"etag-2"', size: 1 },
			],
			durationInSecs: 0.5,
		});

		expect(response.status).toBe(200);
		expect(mocks.listParts).toHaveBeenCalledWith(S3_KEY, "upload-1");
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				amountMicroCredits: -microCreditsFor(40),
				metadata: { durationSeconds: 40, totalBytes: 100_000_000 },
			}),
		]);
		expect(mocks.balance).toBe(10_000_000 - microCreditsFor(40));
		expect(mocks.events).toEqual(["debit", "complete"]);
	});

	it("stores the billed duration when the size floor is longer than the submitted duration", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];
		const response = await complete({ durationInSecs: 0.0001 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 40, width: 1920, height: 1080 },
		]);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				amountMicroCredits: -microCreditsFor(40),
				metadata: { durationSeconds: 40, totalBytes: 100_000_000 },
			}),
		]);
	});

	it("stores the submitted duration when it is longer than the size floor", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const response = await complete({ durationInSecs: 12.5 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 12.5, width: 1920, height: 1080 },
		]);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({ amountMicroCredits: -microCreditsFor(12.5) }),
		]);
	});

	it("only counts the parts the request completes", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 5_000_000 },
			{ PartNumber: 2, ETag: '"etag-2"', Size: 95_000_000 },
		];
		const response = await complete({ durationInSecs: 0.5 });

		expect(response.status).toBe(200);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				metadata: { durationSeconds: 2, totalBytes: 5_000_000 },
			}),
		]);
	});

	it("keeps the submitted duration when it is longer than the size floor", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const response = await complete({ durationInSecs: 120 });

		expect(response.status).toBe(200);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({ amountMicroCredits: -microCreditsFor(120) }),
		]);
	});

	it("keeps the four hour cap for submitted and size-derived durations", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000_000 },
		];
		expect((await complete({ durationInSecs: 1 })).status).toBe(200);

		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				amountMicroCredits: -microCreditsFor(FOUR_HOURS_SECS),
			}),
		]);
		expect(mocks.videoUpdates.map((row) => row.duration)).toEqual([
			FOUR_HOURS_SECS,
		]);

		mocks.storedDuration = null;
		mocks.creditTransactions = [];
		mocks.videoUpdates = [];
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 20_000_000 }];
		expect((await complete({ durationInSecs: 99_999 })).status).toBe(200);

		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				amountMicroCredits: -microCreditsFor(FOUR_HOURS_SECS),
			}),
		]);
		expect(mocks.videoUpdates.map((row) => row.duration)).toEqual([
			FOUR_HOURS_SECS,
		]);
	});

	it("bounds a declared duration by what the uploaded bytes could hold", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 4_000 }];
		const response = await complete({ durationInSecs: FOUR_HOURS_SECS });

		expect(response.status).toBe(200);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({
				amountMicroCredits: -microCreditsFor(4),
				metadata: { durationSeconds: 4, totalBytes: 4_000 },
			}),
		]);
		expect(mocks.videoUpdates.map((row) => row.duration)).toEqual([4]);
	});

	it("accepts the longest duration the uploaded bytes could hold", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 60_000 }];
		expect((await complete({ durationInSecs: 60 })).status).toBe(200);
		expect(mocks.creditTransactions).toEqual([
			expect.objectContaining({ amountMicroCredits: -microCreditsFor(60) }),
		]);
	});

	it("refuses a request that repeats a part, without billing", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 50_000_000 }];
		const repeated = { partNumber: 1, etag: "etag-1", size: 50_000_000 };
		const response = await complete({
			parts: [repeated, repeated, repeated, repeated],
			durationInSecs: 5,
		});

		expect(response.status).toBe(400);
		expect(mocks.creditTransactions).toEqual([]);
		expect(mocks.events).toEqual([]);
	});

	it("accepts part ETags with or without quotes", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000 }];
		const response = await complete({
			parts: [{ partNumber: 1, etag: "etag-1", size: 10_000 }],
			durationInSecs: 3,
		});

		expect(response.status).toBe(200);
		expect(mocks.events).toEqual(["debit", "complete"]);
	});

	it.each([
		[
			"a part storage does not have",
			[{ PartNumber: 2, ETag: '"etag-2"', Size: 1_000 }],
		],
		[
			"a part with a different ETag",
			[{ PartNumber: 1, ETag: '"other"', Size: 1_000 }],
		],
		["a part with no reported size", [{ PartNumber: 1, ETag: '"etag-1"' }]],
	])("rejects %s without billing or completing", async (_, storedParts) => {
		mocks.storedParts = storedParts;
		const response = await complete({ durationInSecs: 30 });

		expect(response.status).toBe(400);
		expect(mocks.balance).toBe(10_000_000);
		expect(mocks.creditTransactions).toEqual([]);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);
	});

	it("leaves the upload open on insufficient credits so a retry after topping up completes it", async () => {
		mocks.balance = 1_000;
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];
		const rejected = await complete({ durationInSecs: 0.5 });

		expect(rejected.status).toBe(402);
		expect(await rejected.json()).toEqual({ error: "Insufficient credits" });
		expect(mocks.balance).toBe(1_000);
		expect(mocks.complete).not.toHaveBeenCalled();

		mocks.balance = 10_000_000;
		const retried = await complete({ durationInSecs: 0.5 });

		expect(retried.status).toBe(200);
		expect(mocks.balance).toBe(10_000_000 - microCreditsFor(40));
		expect(mocks.events).toEqual(["debit", "complete"]);
	});

	it("does not bill when the uploaded parts cannot be listed", async () => {
		mocks.listPartsFails = true;
		const response = await complete({ durationInSecs: 30 });

		expect(response.status).toBe(500);
		expect(mocks.balance).toBe(10_000_000);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("does not debit again when a completed upload is completed a second time", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];
		expect((await complete({ durationInSecs: 0.5 })).status).toBe(200);
		expect((await complete({ durationInSecs: 0.5 })).status).toBe(200);

		expect(mocks.balance).toBe(10_000_000 - microCreditsFor(40));
		expect(mocks.creditTransactions).toHaveLength(1);
		expect(mocks.events).toEqual(["debit", "complete"]);
	});

	it("does not debit again when a retry follows a failed completion", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];
		mocks.completeFailures = 1;
		expect((await complete({ durationInSecs: 0.5 })).status).toBe(500);
		expect((await complete({ durationInSecs: 0.5 })).status).toBe(200);

		expect(mocks.balance).toBe(10_000_000 - microCreditsFor(40));
		expect(mocks.creditTransactions).toHaveLength(1);
		expect(mocks.events).toEqual(["debit", "complete"]);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 40, width: 1920, height: 1080 },
		]);
	});
});
