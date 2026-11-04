import { Effect } from "effect";
import type { Context, Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const state = vi.hoisted(() => ({
	videos: [] as Row[],
	accounts: [] as Row[],
	transactions: [] as Row[],
	storageCalls: [] as string[],
}));

vi.mock("@cap/database/schema", () => ({
	developerVideos: {
		id: "id",
		appId: "appId",
		s3Key: "s3Key",
		deletedAt: "deletedAt",
	},
	developerCreditAccounts: {
		id: "id",
		appId: "appId",
		balanceMicroCredits: "balanceMicroCredits",
	},
	developerCreditTransactions: { id: "id" },
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const rowsOf = (table: unknown) =>
		table === schema.developerVideos
			? state.videos
			: table === schema.developerCreditAccounts
				? state.accounts
				: state.transactions;

	const query = {
		select: () => ({
			from: (table: unknown) => ({
				where: (matches: Predicate) => ({
					limit: async () => rowsOf(table).filter(matches),
				}),
			}),
		}),
		update: (table: unknown) => ({
			set: (values: Row) => ({
				where: async (matches: Predicate) => {
					const rows = rowsOf(table).filter(matches);
					if (table === schema.developerCreditAccounts) {
						const { amount } = values.balanceMicroCredits as { amount: number };
						for (const row of rows)
							row.balanceMicroCredits =
								(row.balanceMicroCredits as number) - amount;
					} else {
						for (const row of rows) Object.assign(row, values);
					}
					return [{ affectedRows: rows.length }];
				},
			}),
		}),
		insert: () => ({
			values: async (values: Row) => {
				state.transactions.push(values);
			},
		}),
	};

	return {
		db: () => ({
			...query,
			transaction: (run: (tx: typeof query) => Promise<unknown>) => run(query),
		}),
	};
});

vi.mock("@cap/database/helpers", () => ({ nanoId: () => "txn" }));
vi.mock("drizzle-orm", () => ({
	and:
		(...conditions: unknown[]) =>
		(row: Row) =>
			conditions.every(
				(condition) =>
					typeof condition !== "function" || (condition as Predicate)(row),
			),
	eq: (field: string, value: unknown) => (row: Row) => row[field] === value,
	isNull: (field: string) => (row: Row) => row[field] == null,
	sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({
		amount: values[1],
	}),
}));
vi.mock("@cap/web-backend", () => {
	const call = <T>(name: string, value: T) =>
		Effect.sync(() => {
			state.storageCalls.push(name);
			return value;
		});
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{
						multipart: {
							create: () => call("create", { UploadId: "upload-1" }),
							getPresignedUploadPartUrl: () => call("presign", "https://part"),
							complete: () => call("complete", undefined),
							abort: () => call("abort", undefined),
						},
					},
				]),
		},
	};
});
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

const bodies = {
	"/initiate": {},
	"/presign-part": { uploadId: "upload-1", partNumber: 1 },
	"/complete": {
		uploadId: "upload-1",
		parts: [{ partNumber: 1, etag: "etag", size: 1000 }],
		durationInSecs: 120,
	},
	"/abort": { uploadId: "upload-1" },
};

function request(path: keyof typeof bodies, videoId: string) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoId, ...bodies[path] }),
	});
}

describe("developer SDK uploads for deleted videos", () => {
	beforeEach(() => {
		state.videos = [
			{ id: "live", appId: "app-1", s3Key: "developer/app-1/live" },
			{
				id: "deleted",
				appId: "app-1",
				s3Key: "developer/app-1/deleted",
				deletedAt: new Date(),
			},
		];
		state.accounts = [
			{ id: "account-1", appId: "app-1", balanceMicroCredits: 100_000 },
		];
		state.transactions = [];
		state.storageCalls = [];
	});

	it.each(["/initiate", "/presign-part", "/complete"] as const)(
		"%s treats a deleted video as not found",
		async (path) => {
			const response = await request(path, "deleted");

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "Video not found" });
			expect(state.storageCalls).toEqual([]);
			expect(state.accounts[0]?.balanceMicroCredits).toBe(100_000);
			expect(state.transactions).toEqual([]);
		},
	);

	it.each(["/initiate", "/presign-part", "/complete"] as const)(
		"%s still serves a live video",
		async (path) => {
			expect((await request(path, "live")).status).toBe(200);
			expect(state.storageCalls).toHaveLength(1);
		},
	);

	it("still aborts an upload left on a deleted video", async () => {
		expect((await request("/abort", "deleted")).status).toBe(200);
		expect(state.storageCalls).toEqual(["abort"]);
	});
});
