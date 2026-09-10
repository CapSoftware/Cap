import type { HttpApi } from "@effect/platform";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	userId: "owner" as string | null,
	where: vi.fn(),
	prepare: vi.fn(),
	dispose: async () => {},
}));

vi.mock("@/lib/desktop-recording-source", () => ({
	prepareDesktopRecordingSegments: mocks.prepare,
}));

vi.mock("@/lib/server", async () => {
	const { Database } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User, DatabaseError } =
		await import("@cap/web-domain");
	const { HttpApiBuilder, HttpApiError, HttpServer } = await import(
		"@effect/platform"
	);
	const { Effect, Layer, Option } = await import("effect");
	const client = {
		select: () => ({
			from: () => ({ leftJoin: () => ({ where: mocks.where }) }),
		}),
	} as unknown as import("@cap/web-backend/src/Database").DbClient;
	const database = Layer.succeed(
		Database,
		Database.make({
			use: (callback) =>
				Effect.tryPromise({
					try: () => callback(client),
					catch: (cause) => new DatabaseError({ cause }),
				}),
		}),
	);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.suspend(() =>
			mocks.userId
				? Effect.succeed({
						id: User.UserId.make(mocks.userId),
						email: "owner@example.com",
						activeOrganizationId: Organisation.OrganisationId.make("org"),
						iconUrlOrKey: Option.none(),
					})
				: Effect.fail(new HttpApiError.Unauthorized()),
		),
	);
	return {
		apiToHandler: (
			api: import("effect").Layer.Layer<
				HttpApi.Api,
				never,
				| import("@cap/web-backend").Database
				| import("@cap/web-domain").HttpAuthMiddleware
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provideMerge(database),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

import { POST } from "@/app/api/recording/prepare/route";

const segments = [{ track: "video", index: 1 }];
const current = {
	video: {
		id: "recording",
		ownerId: "owner",
		source: { type: "desktopSegments" },
	},
	jobId: null,
};

function request(body: unknown = { videoId: "recording", segments }) {
	return POST(
		new Request("http://localhost/api/recording/prepare", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("optional recording preparation API", () => {
	beforeEach(() => {
		mocks.userId = "owner";
		mocks.rows = [[current], [current]];
		mocks.where.mockImplementation(async () => mocks.rows.shift() ?? []);
		mocks.prepare.mockReset().mockResolvedValue(segments);
	});

	afterAll(() => mocks.dispose());

	it("requires authentication before accessing storage", async () => {
		mocks.userId = null;
		expect((await request()).status).toBe(401);
		expect(mocks.where).not.toHaveBeenCalled();
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("limits the lookup to the authenticated recording owner", async () => {
		mocks.rows = [[]];
		expect((await request()).status).toBe(404);
		const [condition] = mocks.where.mock.calls[0] ?? [];
		const query = new MySqlDialect().sqlToQuery(condition);
		expect(query.params).toEqual(["recording", "owner"]);
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it.each(
		[
			[],
			[{ track: "video", index: 0 }],
			[{ track: "video", index: 1.5 }],
			[{ track: "video", index: 50_001 }],
			[{ track: "../video", index: 1 }],
			Array.from({ length: 33 }, (_, index) => ({
				track: "audio",
				index: index + 1,
			})),
		].map((invalid) => ({ invalid })),
	)(
		"rejects an invalid or oversized fragment batch $invalid",
		async ({ invalid }) => {
			expect(
				(await request({ videoId: "recording", segments: invalid })).status,
			).toBe(400);
			expect(mocks.prepare).not.toHaveBeenCalled();
		},
	);

	it.each(["desktopMP4", "webMP4", "local"])(
		"does not prepare a %s source",
		async (type) => {
			mocks.rows = [
				{ ...current, video: { ...current.video, source: { type } } },
			].map((row) => [row]);
			expect(await (await request()).json()).toEqual({
				version: 1,
				prepared: [],
			});
			expect(mocks.prepare).not.toHaveBeenCalled();
		},
	);

	it("does not race an existing finalization or deletion job", async () => {
		mocks.rows = [[{ ...current, jobId: "recording" }]];
		expect(await (await request()).json()).toEqual({
			version: 1,
			prepared: [],
		});
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("rechecks ownership and finalization between copy batches", async () => {
		mocks.rows = [
			[current],
			[current],
			[{ ...current, jobId: "recording" }],
			[],
		];
		mocks.prepare.mockImplementation(async (_video, requested, canContinue) => {
			expect(await canContinue()).toBe(true);
			expect(await canContinue()).toBe(false);
			expect(await canContinue()).toBe(false);
			return requested;
		});
		expect(await (await request()).json()).toEqual({
			version: 1,
			prepared: segments,
		});
		for (const [condition] of mocks.where.mock.calls) {
			expect(new MySqlDialect().sqlToQuery(condition).params).toEqual([
				"recording",
				"owner",
			]);
		}
	});

	it("leaves preparation retryable after a storage error", async () => {
		mocks.prepare.mockRejectedValue(new Error("Storage unavailable"));
		expect((await request()).status).toBe(500);
	});
});
