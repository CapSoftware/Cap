import { setTimeout as delay } from "node:timers/promises";
import {
	CurrentUser,
	DatabaseError,
	HttpAuthMiddleware,
	type Mobile,
	Organisation,
	User,
	type Video,
} from "@cap/web-domain";
import { type HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "http://localhost" }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({ authOptions: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@/actions/loom", () => ({}));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({}));
vi.mock("@/lib/account-deletion-request", () => ({}));
vi.mock("@/lib/desktop-segments-finalization", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		Database,
		Videos: Context.GenericTag("mobile-caps-test/Videos"),
		ImageUploads: Context.GenericTag("mobile-caps-test/ImageUploads"),
	};
});

const user = {
	id: User.UserId.make("viewer"),
	email: "viewer@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org"),
	iconUrlOrKey: Option.none(),
};
const date = "2026-10-24 12:00:00";
let size = 30;
let sharedList = false;
let empty = false;
let denied = false;
let failDatabase = false;
let failAnalytics = false;
let latency = 0;
let activeQueries = 0;
let peakQueries = 0;
let queries: string[] = [];
let analyticsIds: readonly Video.VideoId[] = [];

function owner(index: number) {
	return !sharedList || index % 4 === 0 ? "viewer" : `owner-${index % 4}`;
}

function preferences(id: string) {
	return {
		blockedUserIds:
			id === "viewer" ? ["owner-1"] : id === "owner-2" ? ["viewer"] : [],
	};
}

const client = drizzle(async (sql, params) => {
	queries.push(sql);
	peakQueries = Math.max(peakQueries, ++activeQueries);
	try {
		if (latency) await delay(latency);
		if (failDatabase) throw new Error("database unavailable");
		if (sql.includes("from `organizations`")) {
			return {
				rows: denied ? [] : [["org", "Organization", "viewer", "owner"]],
			};
		}
		if (sql.includes("from `spaces`")) {
			return { rows: [["team", "Team", "Public", "viewer", "admin", false]] };
		}
		if (sql.includes(" group by ")) {
			return {
				rows: empty
					? []
					: Array.from({ length: size }, (_, index) => {
							const id = owner(index);
							return [
								`video-${index}`,
								id,
								`Cap ${index}`,
								date,
								date,
								id === "owner-3" ? null : id,
								...(sql.includes("`users`.`preferences`")
									? [id === "owner-3" ? null : preferences(id)]
									: []),
								60 + index,
								null,
								true,
								index === 3,
								index === 7,
								2,
								1,
								null,
								null,
								null,
								null,
								null,
								null,
								null,
								null,
								null,
							];
						}),
			};
		}
		if (sql.startsWith("select `preferences`")) {
			return { rows: [[preferences("viewer")]] };
		}
		if (sql.startsWith("select `id`, `preferences`")) {
			return {
				rows: ["viewer", "owner-1", "owner-2"].map((id) => [
					id,
					preferences(id),
				]),
			};
		}
		if (sql.includes("from `folders`")) {
			return { rows: [["folder", "Folder", "normal", null, 4]] };
		}
		if (sql.includes("COUNT(")) return { rows: [[61, 81]] };
		if (sql.includes(" order by `videos`.`effectiveCreatedAt` desc limit ")) {
			return {
				rows: empty
					? []
					: Array.from({ length: size }, (_, index) => [
							`video-${index}`,
							params.includes("folder") ? "folder" : null,
						]),
			};
		}
		throw new Error(`Unexpected query: ${sql}`);
	} finally {
		activeQueries--;
	}
});

let dispose: () => Promise<void>;
vi.mock("@/lib/server", async () => {
	const { Videos, ImageUploads } = await import("@cap/web-backend");
	return {
		apiToHandler: (
			api: Layer.Layer<HttpApi.Api, never, Database | HttpAuthMiddleware>,
		) => {
			const web = HttpApiBuilder.toWebHandler(
				api.pipe(
					Layer.provide(
						Layer.succeed(
							Database,
							Database.make({
								use: (callback) =>
									Effect.tryPromise({
										try: () => callback(client as unknown as DbClient),
										catch: (cause) => new DatabaseError({ cause }),
									}),
							}),
						),
					),
					Layer.provide(
						Layer.mock(Videos, {
							_tag: "Videos",
							getAnalyticsBulkForOwner: (ids: readonly Video.VideoId[]) =>
								Effect.gen(function* () {
									analyticsIds = ids;
									if (latency) yield* Effect.promise(() => delay(latency));
									if (failAnalytics)
										return yield* new DatabaseError({
											cause: new Error("analytics unavailable"),
										});
									return ids.map((_, index) => ({ count: index + 10 }));
								}),
						}),
					),
					Layer.provide(Layer.mock(ImageUploads, { _tag: "ImageUploads" })),
					Layer.provide(
						Layer.succeed(
							HttpAuthMiddleware,
							Effect.succeed(CurrentUser.of(user)),
						),
					),
					Layer.merge(HttpServer.layerContext),
				),
			);
			dispose = web.dispose;
			return web.handler;
		},
	};
});

const { GET } = await import("@/app/api/mobile/[...route]/route");

async function list(params = "") {
	sharedList = params.includes("spaceId=");
	return GET(
		new Request(`http://localhost/api/mobile/caps?limit=${size}${params}`),
	);
}

function expectedCaps(folderId: string | null = null) {
	return Array.from({ length: size }, (_, index) => index)
		.filter((index) => !sharedList || index % 4 === 0 || index % 4 === 3)
		.map((index) => {
			const protectedCap = index === 3 || index === 7;
			const owned = owner(index) === "viewer";
			const hasThumbnail = owned || !protectedCap;
			return {
				id: `video-${index}`,
				ownerId: owner(index),
				shareUrl: `http://localhost/s/video-${index}`,
				title: `Cap ${index}`,
				createdAt: "2026-10-24T12:00:00.000Z",
				updatedAt: "2026-10-24T12:00:00.000Z",
				ownerName: owner(index) === "owner-3" ? "" : owner(index),
				durationSeconds: 60 + index,
				thumbnailUrl: hasThumbnail
					? `http://localhost/api/mobile/caps/video-${index}/thumbnail?v=1792843200000`
					: null,
				thumbnailCacheKey: hasThumbnail
					? `cap-thumbnail:video-${index}:1792843200000`
					: null,
				folderId,
				public: true,
				protected: protectedCap,
				viewCount:
					owned && !failAnalytics ? (sharedList ? index / 4 : index) + 10 : 0,
				commentCount: 2,
				reactionCount: 1,
				upload: null,
				ownedByCurrentUser: owned,
			};
		});
}

beforeEach(() => {
	size = 30;
	empty = false;
	denied = false;
	failDatabase = false;
	failAnalytics = false;
	latency = 0;
	activeQueries = 0;
	peakQueries = 0;
	queries = [];
	analyticsIds = [];
});
afterAll(() => dispose());

describe("mobile Caps list", () => {
	it.each(["", "&spaceId=org", "&spaceId=team", "&folderId=folder"])(
		"preserves summaries, blocks, pagination and locations for %s",
		async (params) => {
			const response = await list(`${params}&page=2`);
			expect(response.status).toBe(200);
			const body: typeof Mobile.MobileCapsListResponse.Type =
				await response.json();
			expect(body).toEqual({
				caps: expectedCaps(params.includes("folderId") ? "folder" : null),
				folders: params.includes("folderId")
					? []
					: [
							{
								id: "folder",
								name: "Folder",
								color: "normal",
								parentId: null,
								videoCount: 4,
							},
						],
				page: 2,
				limit: 30,
				total: 61,
				collectionTotal: 81,
				hasMore: true,
			});
			expect(analyticsIds).toEqual(
				body.caps.filter((cap) => cap.ownedByCurrentUser).map((cap) => cap.id),
			);
		},
	);

	it.each([
		["", 6, 4],
		["&spaceId=org", 7, 4],
		["&spaceId=team", 8, 4],
		["&folderId=folder", 5, 3],
	] as const)(
		"bounds SQL requests and overlaps independent reads for %s",
		async (params, count, peak) => {
			latency = 5;
			expect((await list(params)).status).toBe(200);
			expect(queries).toHaveLength(count);
			expect(peakQueries).toBe(peak);
		},
	);

	it("keeps collection totals on an empty page", async () => {
		empty = true;
		const response = await list("&page=4");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			caps: [],
			total: 61,
			collectionTotal: 81,
			hasMore: false,
		});
		expect(queries).toHaveLength(4);
		expect(analyticsIds).toEqual([]);
	});

	it("keeps zero views when analytics fails", async () => {
		failAnalytics = true;
		const response = await list();
		expect(response.status).toBe(200);
		expect((await response.json()).caps).toEqual(expectedCaps());
	});

	it("rejects inaccessible spaces before loading caps", async () => {
		denied = true;
		expect((await list("&spaceId=team")).status).toBe(403);
		expect(queries).toHaveLength(1);
		expect(analyticsIds).toEqual([]);
	});

	it("returns an error when a required database read fails", async () => {
		failDatabase = true;
		expect((await list()).status).toBe(500);
		expect(analyticsIds).toEqual([]);
	});

	it.skipIf(!process.env.CAP_API_LIST_BENCH)(
		"benchmarks the GET handler with 40 ms dependency latency",
		async () => {
			latency = 40;
			for (const pageSize of [20, 30, 50]) {
				size = pageSize;
				await list();
				const samples: number[] = [];
				for (let sample = 0; sample < 7; sample++) {
					queries = [];
					peakQueries = 0;
					const start = performance.now();
					const response = await list();
					expect(response.status).toBe(200);
					expect((await response.json()).caps).toEqual(expectedCaps());
					samples.push(performance.now() - start);
				}
				console.log(
					JSON.stringify({
						pageSize,
						latency,
						medianMs: samples.sort((a, b) => a - b)[3],
						sqlRequests: queries.length,
						peakQueries,
					}),
				);
			}
		},
	);
});
