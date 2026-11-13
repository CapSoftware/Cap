import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	appId: "app-1",
	playbackUrl: undefined as string | undefined,
	redrive: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const database = await createDeveloperVideoDatabase(mocks.store);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://web.example",
		INFRA_PLAYBACK_URL: mocks.playbackUrl,
	}),
}));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: mocks.redrive,
}));
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", mocks.appId);
			c.set("developerKeyType", "secret");
			await next();
		}),
	};
});

const { app } = await import("@/app/api/developer/v1/[...route]/videos");

const BASE =
	"https://web.example/api/developer/playback/playback-id-0123456789ab";
const PAGE = "https://web.example/dev/playback-id-0123456789ab";
const ready = () =>
	developerVideo({
		status: "ready",
		storedBytes: 9_000,
		renditions: [
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bitrate: 3_000_000,
				bytes: 5_000,
				codecs: "avc1.640028,mp4a.40.2",
			},
		],
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
			bytes: { source: 1_000, hls: 5_000, mp4: 2_950, poster: 50 },
		}),
	});

async function get(path: string) {
	const response = await app.request(path);
	return { status: response.status, body: await response.json() };
}

const ITEM_ROUTES = [
	["GET", "/video-1"],
	["GET", "/video-1/status"],
	["DELETE", "/video-1"],
] as const;

const docs = readFileSync(
	join(process.cwd(), "content/docs/api/rest-api.mdx"),
	"utf8",
);

function docsSection(heading: string) {
	const start = docs.indexOf(`\n${heading}\n`);
	if (start === -1) throw new Error(`The docs have no section ${heading}`);
	const level = heading.slice(0, heading.indexOf(" ") + 1);
	const end = docs.indexOf(`\n${level}`, start + heading.length);
	return docs.slice(start, end === -1 ? undefined : end);
}

function docsExampleResponse(heading: string) {
	const section = docsSection(heading);
	const example = section
		.slice(section.indexOf("**Example response:**"))
		.match(/```json\n([\s\S]*?)```/)?.[1];
	if (!example) throw new Error(`${heading} has no example response`);
	return JSON.parse(example).data as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = ready();
	mocks.store.more = [];
	mocks.store.updates = [];
	mocks.appId = "app-1";
	mocks.playbackUrl = undefined;
	mocks.redrive.mockResolvedValue(false);
});

describe("developer video API", () => {
	it("returns status, playback URLs and renditions alongside the existing fields", async () => {
		const { status, body } = await get("/video-1");

		expect(status).toBe(200);
		expect(body.data).toEqual({
			id: "video-1",
			appId: "app-1",
			externalUserId: null,
			name: "Untitled",
			duration: 12,
			width: 1920,
			height: 1080,
			fps: 30,
			transcriptionStatus: null,
			metadata: null,
			status: "ready",
			playbackId: "playback-id-0123456789ab",
			maxResolutionTier: "1080p",
			renditions: [
				{
					name: "1080p",
					width: 1920,
					height: 1080,
					bitrate: 3_000_000,
					bytes: 5_000,
					codecs: "avc1.640028,mp4a.40.2",
				},
			],
			storedBytes: 9_000,
			errorReason: null,
			deletedAt: null,
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			hlsUrl: `${BASE}/master.m3u8`,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
	});

	it("lists videos in the same shape", async () => {
		const { body } = await get("/");

		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			status: "ready",
			hlsUrl: `${BASE}/master.m3u8`,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
		expect(body.data[0]).not.toHaveProperty("processing");
	});

	it("keeps the storage key out of get and list responses", async () => {
		for (const path of ["/video-1", "/"]) {
			const { body } = await get(path);
			expect(JSON.stringify(body)).not.toContain("s3Key");
			expect(JSON.stringify(body)).not.toContain("developer/app-1");
		}
	});

	it("returns exactly the fields the OpenAPI description lists", async () => {
		const { developerOpenApiSpec } = await import("@/lib/developer-openapi");
		const schemas = developerOpenApiSpec("https://cap.so").components.schemas;

		const video = await get("/video-1");
		expect(Object.keys(video.body.data).sort()).toEqual(
			Object.keys(schemas.DeveloperVideo.properties).sort(),
		);
		const status = await get("/video-1/status");
		expect(Object.keys(status.body.data).sort()).toEqual(
			Object.keys(schemas.VideoStatus.properties).sort(),
		);
	});

	it("returns exactly the fields the docs list", async () => {
		const video = Object.keys((await get("/video-1")).body.data).sort();
		const status = Object.keys((await get("/video-1/status")).body.data).sort();
		const reference = [
			...docsSection("## Video Object Reference").matchAll(/^\| `(\w+)` \|/gm),
		].map((row) => row[1]);

		expect(reference.sort()).toEqual(video);
		expect(Object.keys(docsExampleResponse("### Get Video")).sort()).toEqual(
			video,
		);
		expect(
			Object.keys(docsExampleResponse("### Get Video Status")).sort(),
		).toEqual(status);
	});

	describe("list filters", () => {
		beforeEach(() => {
			mocks.store.video = { ...ready(), externalUserId: "user-1" };
		});

		it.each([
			["userId=user-1", 1],
			["externalUserId=user-1", 1],
			["userId=user-1&externalUserId=user-1", 1],
			["userId=user-2", 0],
			["externalUserId=user-2", 0],
			["limit=1&offset=0", 1],
		])("applies ?%s", async (query, count) => {
			const { status, body } = await get(`/?${query}`);

			expect(status).toBe(200);
			expect(body.data).toHaveLength(count);
		});

		it.each([
			["externalUserid=user-2", "unknown_parameter"],
			["userid=user-2", "unknown_parameter"],
			["user_id=user-2", "unknown_parameter"],
			["limit=0", "invalid_limit"],
			["limit=abc", "invalid_limit"],
			["limit=-1", "invalid_limit"],
			["limit=101", "invalid_limit"],
			["offset=abc", "invalid_offset"],
			["offset=-5", "invalid_offset"],
			["userId=user-1&externalUserId=user-2", "conflicting_parameters"],
			["userId=", "invalid_user_id"],
			["userId", "invalid_user_id"],
			["externalUserId=", "invalid_user_id"],
			["userId=&limit=10", "invalid_user_id"],
			["userId=&externalUserId=user-1", "invalid_user_id"],
			["userId=user-1&externalUserId=", "invalid_user_id"],
			["userId=%20", "invalid_user_id"],
			["userId=%20%09%20", "invalid_user_id"],
			["externalUserId=%20", "invalid_user_id"],
			["userId=user-1&userId=user-2", "repeated_parameter"],
			["userId=user-2&userId=user-1", "repeated_parameter"],
			["userId=user-1&userId=user-1", "repeated_parameter"],
			["externalUserId=user-1&externalUserId=user-2", "repeated_parameter"],
			["userId=user-1&limit=1&limit=100", "repeated_parameter"],
			["offset=0&offset=0", "repeated_parameter"],
		])("refuses ?%s rather than listing every video", async (query, code) => {
			const { status, body } = await get(`/?${query}`);

			expect(status).toBe(400);
			expect(body).toMatchObject({ code });
			expect(typeof body.error).toBe("string");
			expect(typeof body.hint).toBe("string");
			expect(body).not.toHaveProperty("data");
		});

		it("says the filter was empty and how to list everyone", async () => {
			const { body } = await get("/?externalUserId=");

			expect(body).toMatchObject({
				error: "userId filter is empty",
				code: "invalid_user_id",
				hint: "Send the user ID to filter by, or leave externalUserId out to list every video.",
			});
		});

		it.each(["userId", "externalUserId"])(
			"trims the spaces around %s before matching",
			async (name) => {
				mocks.store.video = { ...ready(), externalUserId: "user 1" };
				const scope = `${name}=%20user%201%09`;

				expect((await get(`/?${scope}`)).body.data).toHaveLength(1);
				expect((await get(`/video-1?${scope}`)).status).toBe(200);
				expect((await get(`/video-1/status?${scope}`)).status).toBe(200);
				expect((await get(`/?${name}=user1`)).body.data).toEqual([]);

				const removed = await app.request(`/video-1?${scope}`, {
					method: "DELETE",
				});
				expect(removed.status).toBe(200);
				expect(mocks.store.updates).toHaveLength(1);
			},
		);

		it("takes a padded copy of the same value in both names as one filter", async () => {
			const { status, body } = await get(
				"/?userId=user-1&externalUserId=%20user-1",
			);

			expect(status).toBe(200);
			expect(body.data).toHaveLength(1);
		});
	});

	describe("paging", () => {
		const sameSecond = new Date("2026-01-01T00:00:00.000Z");
		const page = async (query: string) => {
			const { body } = await get(`/?${query}`);
			return {
				ids: body.data.map((video: { id: string }) => video.id),
				pagination: body.pagination,
			};
		};

		beforeEach(() => {
			mocks.store.video = { ...ready(), id: "video-b", createdAt: sameSecond };
			mocks.store.more = [
				{ ...ready(), id: "video-a", createdAt: sameSecond },
				{ ...ready(), id: "video-c", createdAt: sameSecond },
				{
					...ready(),
					id: "video-old",
					createdAt: new Date("2025-01-01T00:00:00.000Z"),
				},
			];
		});

		it("returns videos created in the same second in the same order on every call", async () => {
			const order = ["video-c", "video-b", "video-a", "video-old"];

			for (let call = 0; call < 4; call++) {
				expect((await page("limit=10")).ids).toEqual(order);
			}
		});

		it("never returns a video on two pages or skips one", async () => {
			const seen: string[] = [];
			for (let offset = 0; offset < 4; offset++) {
				seen.push(...(await page(`limit=1&offset=${offset}`)).ids);
			}

			expect(seen).toEqual(["video-c", "video-b", "video-a", "video-old"]);
		});

		it.each([
			["limit=1", true],
			["limit=3", true],
			["limit=2&offset=1", true],
			["limit=4", false],
			["limit=3&offset=1", false],
			["limit=10", false],
			["limit=2&offset=4", false],
		])(
			"reports with ?%s whether another video follows",
			async (query, hasMore) => {
				const { ids, pagination } = await page(query);
				const params = new URLSearchParams(query);
				const limit = Number(params.get("limit"));
				const offset = Number(params.get("offset") ?? 0);

				expect(pagination).toEqual({ limit, offset, hasMore });
				expect(ids).toHaveLength(Math.max(0, Math.min(limit, 4 - offset)));
			},
		);

		it("returns the list fields the docs and the OpenAPI description show", async () => {
			const { developerOpenApiSpec } = await import("@/lib/developer-openapi");
			const documented =
				developerOpenApiSpec("https://cap.so").components.schemas
					.DeveloperVideoList.properties;
			const example = JSON.parse(
				docsSection("### List Videos").match(/```json\n([\s\S]*?)```/)?.[1] ??
					"{}",
			);
			const { body } = await get("/?limit=1");

			expect(Object.keys(example)).toEqual(Object.keys(body));
			expect(Object.keys(documented)).toEqual(Object.keys(body));
			expect(Object.keys(example.pagination)).toEqual(
				Object.keys(body.pagination),
			);
			expect(Object.keys(documented.pagination.properties)).toEqual(
				Object.keys(body.pagination),
			);
		});

		it("counts only the filtered user's videos toward hasMore", async () => {
			mocks.store.more = (mocks.store.more ?? []).map((video) => ({
				...video,
				externalUserId: video.id === "video-a" ? "alice" : "bob",
			}));

			expect(await page("userId=alice&limit=1")).toEqual({
				ids: ["video-a"],
				pagination: { limit: 1, offset: 0, hasMore: false },
			});
		});
	});

	describe("exact user match", () => {
		const variants = [
			"ALICE",
			"Alice",
			"àlice",
			"Alicé",
			"ÀLICÉ",
			"alic",
			"a lice",
			"alice%",
			"a_ice",
		];

		beforeEach(() => {
			mocks.store.video = { ...ready(), externalUserId: "alice" };
		});

		it("lists alice's videos for alice", async () => {
			const { status, body } = await get("/?userId=alice");

			expect(status).toBe(200);
			expect(body.data).toHaveLength(1);
		});

		it.each(variants)("lists nothing for %j", async (userId) => {
			for (const name of ["userId", "externalUserId"]) {
				const { status, body } = await get(
					`/?${name}=${encodeURIComponent(userId)}`,
				);

				expect(status).toBe(200);
				expect(body.data).toEqual([]);
			}
		});

		it.each(variants)(
			"hides the video from get, status and delete for %j",
			async (userId) => {
				const scope = `?userId=${encodeURIComponent(userId)}`;

				for (const [method, path] of ITEM_ROUTES) {
					const response = await app.request(`${path}${scope}`, { method });

					expect(response.status).toBe(404);
					expect(await response.json()).toMatchObject({
						code: "video_not_found",
					});
				}
				expect(mocks.store.updates).toHaveLength(0);
			},
		);

		it("matches a user whose ID has capitals and accents only as written", async () => {
			mocks.store.video = { ...ready(), externalUserId: "Zoë" };

			expect((await get("/?userId=Zo%C3%AB")).body.data).toHaveLength(1);
			expect((await get("/?userId=zoe")).body.data).toEqual([]);
			expect((await get("/video-1?userId=Zo%C3%AB")).status).toBe(200);
			expect((await get("/video-1?userId=ZOË")).status).toBe(404);
		});

		it("keeps the indexed equality and adds a byte comparison", async () => {
			const { exactUserIdMatch } = await import("@/lib/developer-user-scope");
			const { developerVideos } = await import("@cap/database/schema");

			const match = exactUserIdMatch(developerVideos.externalUserId, "alice");
			if (!match) throw new Error("The exact match built no condition");
			const query = new MySqlDialect().sqlToQuery(match);

			expect(query.sql).toBe(
				"(`developer_videos`.`externalUserId` = ? and CAST(`developer_videos`.`externalUserId` AS BINARY) = CAST(? AS BINARY))",
			);
			expect(query.params).toEqual(["alice", "alice"]);
		});
	});

	describe("scoped to a user", () => {
		beforeEach(() => {
			mocks.store.video = { ...ready(), externalUserId: "alice" };
		});

		it.each(["userId", "externalUserId"])(
			"returns the video and its status to its own user with ?%s",
			async (name) => {
				const video = await get(`/video-1?${name}=alice`);
				const status = await get(`/video-1/status?${name}=alice`);

				expect(video.status).toBe(200);
				expect(video.body.data).toMatchObject({
					id: "video-1",
					externalUserId: "alice",
				});
				expect(status.status).toBe(200);
				expect(status.body.data).toMatchObject({
					id: "video-1",
					externalUserId: "alice",
					ready: true,
				});
			},
		);

		it.each(ITEM_ROUTES)(
			"answers 404 to another user for %s %s",
			async (method, path) => {
				const response = await app.request(`${path}?userId=bob`, { method });

				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					error: "Video not found",
					code: "video_not_found",
					hint: expect.stringContaining("created with this userId"),
				});
				expect(mocks.store.updates).toHaveLength(0);
				expect(mocks.redrive).not.toHaveBeenCalled();
			},
		);

		it("answers 404 for a video that has no user", async () => {
			mocks.store.video = ready();

			expect((await get("/video-1?userId=alice")).status).toBe(404);
			expect((await get("/video-1/status?userId=alice")).status).toBe(404);
			const removed = await app.request("/video-1?userId=alice", {
				method: "DELETE",
			});
			expect(removed.status).toBe(404);
			expect(mocks.store.updates).toHaveLength(0);
		});

		it("deletes the video for its own user and leaves it for anyone else", async () => {
			const refused = await app.request("/video-1?userId=bob", {
				method: "DELETE",
			});
			expect(refused.status).toBe(404);
			expect(mocks.store.video?.deletedAt).toBeNull();

			const removed = await app.request("/video-1?userId=alice", {
				method: "DELETE",
			});
			expect(removed.status).toBe(200);
			expect(await removed.json()).toEqual({ success: true });
			expect(mocks.store.updates).toEqual([{ deletedAt: expect.any(Date) }]);

			const repeated = await app.request("/video-1?userId=alice", {
				method: "DELETE",
			});
			expect(repeated.status).toBe(200);
			expect(mocks.store.updates).toHaveLength(1);
		});

		it("says the filter was empty and how to drop it", async () => {
			const { status, body } = await get("/video-1?userId=");

			expect(status).toBe(400);
			expect(body).toMatchObject({
				error: "userId filter is empty",
				code: "invalid_user_id",
				hint: "Send the user ID to filter by, or leave userId out to reach any video of the app.",
			});
		});

		it("still serves every video of the app when no user is sent", async () => {
			expect((await get("/video-1")).status).toBe(200);
			expect((await get("/video-1/status")).status).toBe(200);
		});

		it.each([
			["userId=", "invalid_user_id"],
			["userId", "invalid_user_id"],
			["externalUserId=", "invalid_user_id"],
			["userId=%20", "invalid_user_id"],
			["userId=alice&userId=bob", "repeated_parameter"],
			["userId=alice&userId=alice", "repeated_parameter"],
			["userId=alice&externalUserId=bob", "conflicting_parameters"],
			["userid=alice", "unknown_parameter"],
			["user=alice", "unknown_parameter"],
			["userId=alice&limit=1", "unknown_parameter"],
		])(
			"refuses ?%s on get, status and delete instead of dropping the scope",
			async (query, code) => {
				for (const [method, path] of ITEM_ROUTES) {
					const response = await app.request(`${path}?${query}`, { method });
					const body = await response.json();

					expect(response.status).toBe(400);
					expect(body).toMatchObject({ code });
					expect(typeof body.error).toBe("string");
					expect(typeof body.hint).toBe("string");
					expect(body).not.toHaveProperty("data");
					expect(body).not.toHaveProperty("success");
				}
				expect(mocks.store.updates).toHaveLength(0);
			},
		);
	});

	describe("not found", () => {
		it.each([
			["GET", "/missing"],
			["GET", "/missing/status"],
			["DELETE", "/missing"],
		])("gives %s %s a code and a hint", async (method, path) => {
			const response = await app.request(path, { method });

			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				error: "Video not found",
				code: "video_not_found",
				hint: expect.stringContaining("belongs to this app"),
			});
		});

		it("hides a deleted video from get and status", async () => {
			mocks.store.video = { ...ready(), deletedAt: new Date() };

			for (const path of ["/video-1", "/video-1/status"]) {
				const { status, body } = await get(path);
				expect(status).toBe(404);
				expect(body.code).toBe("video_not_found");
			}
		});
	});

	describe("delete", () => {
		const remove = (path = "/video-1") =>
			app.request(path, { method: "DELETE" });

		it("deletes a video", async () => {
			const response = await remove();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(mocks.store.updates).toEqual([{ deletedAt: expect.any(Date) }]);
		});

		it("answers a repeated delete with success and leaves the row alone", async () => {
			const first = await remove();
			const deletedAt = mocks.store.video?.deletedAt;
			const second = await remove();

			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ success: true });
			expect(mocks.store.updates).toHaveLength(1);
			expect(mocks.store.video?.deletedAt).toBe(deletedAt);
		});

		it("still answers 404 for a video of another app, deleted or not", async () => {
			for (const deletedAt of [null, new Date()]) {
				mocks.store.video = { ...ready(), appId: "app-2", deletedAt };

				const response = await remove();

				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					code: "video_not_found",
				});
			}
			expect(mocks.store.updates).toHaveLength(0);
		});

		it("answers 404 for a video that never existed", async () => {
			mocks.store.video = null;

			const response = await remove();

			expect(response.status).toBe(404);
			expect(mocks.store.updates).toHaveLength(0);
		});
	});

	it("links the player page by playback ID, never by video ID", async () => {
		const { body } = await get("/video-1");

		expect(body.data.shareUrl).not.toContain(body.data.id);
		expect(body.data.embedUrl).not.toContain(body.data.id);
	});

	it("links the player page before the video is ready", async () => {
		mocks.store.video = developerVideo({ status: "processing" });

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({
			hlsUrl: null,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
	});

	it("has no player page for a video without a playback ID", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: null,
			processing: null,
		});

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({ shareUrl: null, embedUrl: null });
	});

	it("keeps the status endpoint's fields and adds playback", async () => {
		const { body } = await get("/video-1/status");

		expect(body.data).toEqual({
			id: "video-1",
			externalUserId: null,
			duration: 12,
			width: 1920,
			height: 1080,
			transcriptionStatus: null,
			ready: true,
			status: "ready",
			errorReason: null,
			playbackId: "playback-id-0123456789ab",
			renditions: ready().renditions,
			hlsUrl: `${BASE}/master.m3u8`,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
		});
	});

	it("keeps a video uploaded before encoding existed ready", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: null,
			processing: null,
			updatedAt: new Date(Date.now() - 60 * 60_000),
		});
		mocks.redrive.mockImplementation(async () => {
			throw new Error("a legacy video must not be re-encoded on read");
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: true,
			status: "uploading",
			hlsUrl: null,
			mp4Url: null,
		});
	});

	it("does not call an unfinished upload ready", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: "playback-id-0123456789ab",
			duration: null,
			processing: null,
		});

		const { body } = await get("/video-1/status");

		expect(body.data.ready).toBe(false);
	});

	it("offers no URLs until the video is ready", async () => {
		mocks.store.video = developerVideo({
			status: "processing",
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
			}),
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: false,
			status: "processing",
			hlsUrl: null,
			mp4Url: null,
			posterUrl: null,
			renditions: [],
		});
	});

	it("offers the MP4 while adaptive streaming is still encoding", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				hls: {
					state: "running",
					token: "t-hls",
					jobId: "job-1",
					startedAt: Date.now(),
				},
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
			}),
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: true,
			status: "ready",
			hlsUrl: null,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			renditions: [],
		});
		expect(mocks.redrive).not.toHaveBeenCalled();
	});

	it("offers only the MP4 while adaptive streaming is unavailable", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				hls: { state: "unavailable", reason: "not deployed", retryAt: 0 },
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({
			status: "ready",
			hlsUrl: null,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			renditions: [],
		});
		expect(mocks.redrive).toHaveBeenCalledExactlyOnceWith("video-1");
	});

	it("reports the error reason for a failed video", async () => {
		mocks.store.video = developerVideo({
			status: "errored",
			errorReason: "Uploaded file has no video track",
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: false,
			status: "errored",
			errorReason: "Uploaded file has no video track",
		});
		expect(mocks.redrive).not.toHaveBeenCalled();
	});

	it("tells the owner about a credit shortfall the public page keeps to itself", async () => {
		const errorReason =
			"Not enough credit to store this video at its measured length and size. Add at least $0.05 of credit and upload it again.";
		mocks.store.video = developerVideo({ status: "errored", errorReason });

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({ status: "errored", errorReason });
	});

	it("builds URLs on the configured playback hostname", async () => {
		mocks.playbackUrl = "https://stream.example/";

		const { body } = await get("/video-1");

		expect(body.data.hlsUrl).toBe(
			"https://stream.example/playback-id-0123456789ab/master.m3u8",
		);
	});

	it("does not return another app's video", async () => {
		mocks.appId = "app-2";

		expect((await get("/video-1")).status).toBe(404);
		expect((await get("/video-1/status")).status).toBe(404);
	});
});
