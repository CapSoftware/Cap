import { Effect } from "effect";
import type { Context, Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	balance: 0,
	transactions: [] as Record<string, unknown>[],
	accountLock: Promise.resolve(),
	completeUpload: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	developerVideos: { id: "id" },
	developerCreditAccounts: {
		id: "id",
		appId: "appId",
		balanceMicroCredits: "balanceMicroCredits",
	},
	developerCreditTransactions: {
		id: "id",
		accountId: "accountId",
		referenceId: "referenceId",
		referenceType: "referenceType",
	},
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	type Condition = { field: string; value: unknown };

	const rowsFor = (table: unknown, conditions: Condition[]) => {
		if (table === schema.developerVideos) {
			const id = conditions[0]?.value;
			return [{ id, appId: "app-1", s3Key: `developer/app-1/${id}` }];
		}
		if (table === schema.developerCreditAccounts) {
			return [{ id: "account-1", balanceMicroCredits: state.balance }];
		}
		return state.transactions.filter((row) =>
			conditions.every(({ field, value }) => row[field] === value),
		);
	};

	const query = (lockAccount: () => Promise<void>) => ({
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: Condition | Condition[]) => {
					const read = () => rowsFor(table, [condition].flat());
					return Object.assign(Promise.resolve(read()), {
						limit: () =>
							Object.assign(Promise.resolve(read()), {
								for: async () => {
									await lockAccount();
									return read();
								},
							}),
					});
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (values: { balanceMicroCredits?: { amount: number } }) => ({
				where: async () => {
					const amount = values.balanceMicroCredits?.amount;
					if (table !== schema.developerCreditAccounts || amount === undefined)
						return [{ affectedRows: 1 }];
					if (state.balance < amount) return [{ affectedRows: 0 }];
					state.balance -= amount;
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				state.transactions.push(values);
			},
		}),
	});

	return {
		db: () => ({
			...query(async () => {}),
			transaction: async (
				run: (tx: ReturnType<typeof query>) => Promise<unknown>,
			) => {
				let release: (() => void) | undefined;
				const lockAccount = async () => {
					const previous = state.accountLock;
					state.accountLock = new Promise((resolve) => {
						release = resolve;
					});
					await previous;
				};
				try {
					return await run(query(lockAccount));
				} finally {
					release?.();
				}
			},
		}),
	};
});

vi.mock("@cap/database/helpers", () => ({ nanoId: () => "txn" }));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => conditions.flat(),
	eq: (field: string, value: unknown) => ({ field, value }),
	sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({
		amount: values[1],
	}),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {
		getBucketAccess: () =>
			Effect.succeed([
				{
					multipart: {
						complete: () => Effect.promise(() => state.completeUpload()),
					},
				},
			]),
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
}));
vi.mock("@/app/api/utils", () => ({
	withDeveloperPublicAuth: async (context: Context, next: Next) => {
		context.set("developerAppId", "app-1");
		await next();
	},
}));

import { app } from "@/app/api/developer/sdk/v1/[...route]/upload";

function complete(videoId: string, durationInSecs = 120) {
	return app.request("/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId,
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: "etag", size: 1000 }],
			durationInSecs,
		}),
	});
}

describe("developer SDK upload completion billing", () => {
	beforeEach(() => {
		state.balance = 100_000;
		state.transactions = [];
		state.accountLock = Promise.resolve();
		state.completeUpload.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("charges a video once when completion is retried after a storage failure", async () => {
		state.completeUpload.mockRejectedValueOnce(new Error("S3 unavailable"));

		expect((await complete("video-1")).status).toBe(500);
		expect((await complete("video-1")).status).toBe(200);

		expect(state.balance).toBe(90_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("charges a video once when a completed upload is confirmed again", async () => {
		expect((await complete("video-1")).status).toBe(200);
		expect((await complete("video-1")).status).toBe(200);

		expect(state.balance).toBe(90_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("charges a video once when storage rejects a repeated completion", async () => {
		expect((await complete("video-1")).status).toBe(200);

		state.completeUpload.mockRejectedValueOnce(new Error("NoSuchUpload"));
		expect((await complete("video-1")).status).toBe(500);

		expect(state.balance).toBe(90_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("charges a video once when completion requests race", async () => {
		const responses = await Promise.all([
			complete("video-1"),
			complete("video-1"),
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(state.balance).toBe(90_000);
		expect(state.transactions).toHaveLength(1);
	});

	it("charges only the difference when a video is re-uploaded with a longer recording", async () => {
		expect((await complete("video-1")).status).toBe(200);
		expect((await complete("video-1", 300)).status).toBe(200);

		expect(state.balance).toBe(75_000);
		expect(state.transactions.map((row) => row.amountMicroCredits)).toEqual([
			-10_000, -15_000,
		]);
	});

	it("charges each video separately", async () => {
		expect((await complete("video-1")).status).toBe(200);
		expect((await complete("video-2")).status).toBe(200);

		expect(state.balance).toBe(80_000);
		expect(state.transactions).toHaveLength(2);
	});
});
