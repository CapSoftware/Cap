import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	user: null as { id: string; email: string } | null,
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const { withTakedownSql } = await import(
		"../fixtures/developer-video-takedown"
	);
	const database = await withTakedownSql(
		mocks.store,
		await createDeveloperVideoDatabase(mocks.store),
	);
	return { db: () => database };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));

const takedown = await import("@/lib/developer-video-takedown");
const store = await import("@/lib/developer-video-takedown-store");
const sqlHelpers = await import("@cap/database/developer-video-takedown");
const api = await import("@/lib/developer-video-api");
const view = await import("@/lib/infra-video-view");
const { POST } = await import("@/app/api/admin/developer-video-takedown/route");
const script = await import("../../../../scripts/infra-video-takedown");

const PLAYBACK_ID = "playback-id-0123456789ab";
const NOW = new Date("2026-11-13T12:00:00.000Z");
const STAFF = { id: "staff-user", email: "richie@cap.so" };

const ready = (overrides: Parameters<typeof developerVideo>[0] = {}) =>
	developerVideo({
		status: "ready",
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
		}),
		...overrides,
	});

const admin = (body: unknown, headers: Record<string, string> = {}) =>
	POST(
		new Request("https://web.example/api/admin/developer-video-takedown", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);

beforeEach(() => {
	mocks.store.video = ready();
	mocks.store.more = [];
	mocks.store.updates = [];
	mocks.store.appDeleted = false;
	mocks.user = STAFF;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("takedown marker", () => {
	it("keeps the developer's metadata whole and gives it back on restore", async () => {
		const metadata = { orderId: 42, nested: { list: [1, "two"] } };
		mocks.store.video = ready({ metadata });

		await store.setDeveloperVideoTakedown(PLAYBACK_ID, true, NOW);
		const stored = mocks.store.video?.metadata;

		expect(stored).toEqual({
			__capTakedown: { at: NOW.toISOString(), metadata },
		});
		expect(takedown.developerVideoIsTakenDown({ metadata: stored })).toBe(true);
		expect(takedown.developerVideoTakenDownAt(stored)).toBe(NOW.toISOString());
		expect(takedown.developerVideoPublicMetadata(stored)).toEqual(metadata);

		await store.setDeveloperVideoTakedown(PLAYBACK_ID, false, NOW);
		expect(mocks.store.video?.metadata).toEqual(metadata);
	});

	it.each([
		null,
		{},
		{ __capTakedown: "a developer value" },
		{ __capTakedown: { at: 5, metadata: null } },
		{ __capTakedown: { at: "2026-11-13" } },
		[1, 2],
		"text",
	])("does not read %j as taken down", (metadata) => {
		expect(takedown.developerVideoIsTakenDown({ metadata })).toBe(false);
		expect(takedown.developerVideoPublicMetadata(metadata)).toEqual(metadata);
	});

	it("drops the reserved key from metadata a developer sends, and leaves other metadata as sent", () => {
		const own = { a: 1 };
		expect(takedown.withoutReservedMetadata(own)).toBe(own);
		expect(takedown.withoutReservedMetadata(undefined)).toBeUndefined();
		expect(
			takedown.withoutReservedMetadata({ a: 1, __capTakedown: { at: "x" } }),
		).toEqual({ a: 1 });
	});

	it("rewrites metadata in SQL so large numbers in it are never parsed and written back", () => {
		const dialect = new MySqlDialect();
		const down = dialect.sqlToQuery(sqlHelpers.takenDownMetadataSql(NOW));
		const restore = dialect.sqlToQuery(sqlHelpers.restoredMetadataSql());
		const listed = dialect.sqlToQuery(sqlHelpers.developerVideoTakenDownSql());

		expect(down.sql).toBe(
			"JSON_OBJECT(?, JSON_OBJECT('at', ?, 'metadata', `developer_videos`.`metadata`))",
		);
		expect(down.params).toEqual(["__capTakedown", NOW.toISOString()]);
		expect(restore.sql).toBe(
			"CASE WHEN JSON_TYPE(JSON_EXTRACT(`developer_videos`.`metadata`, ?)) = 'NULL' THEN NULL ELSE JSON_EXTRACT(`developer_videos`.`metadata`, ?) END",
		);
		expect(restore.params).toEqual([
			'$."__capTakedown".metadata',
			'$."__capTakedown".metadata',
		]);
		expect(listed.sql).toMatch(/^COALESCE\(\(JSON_TYPE\(.*\), FALSE\)$/);
		expect(listed.params).toEqual([
			'$."__capTakedown".at',
			'$."__capTakedown".metadata',
		]);
	});
});

describe("the takedown switch", () => {
	it.each([
		["a playback id", PLAYBACK_ID],
		["a video id", "video-1"],
		["the hosted page", `https://cap.so/dev/${PLAYBACK_ID}`],
		["the embed", `https://cap.so/dev/${PLAYBACK_ID}/embed?autoplay=1`],
		[
			"a playback file",
			`https://cap.so/api/developer/playback/${PLAYBACK_ID}/master.m3u8`,
		],
		["a playback host", `https://play.example/${PLAYBACK_ID}/video.mp4`],
	])("finds the video from %s", async (_, input) => {
		const result = await store.setDeveloperVideoTakedown(input, true, NOW);

		expect(result).toEqual({
			videoId: "video-1",
			appId: "app-1",
			playbackId: PLAYBACK_ID,
			takenDown: true,
			takenDownAt: NOW.toISOString(),
			changed: true,
		});
	});

	it("only writes metadata, so status, duration and every billed column stay as they were", async () => {
		const before = { ...mocks.store.video };

		await store.setDeveloperVideoTakedown(PLAYBACK_ID, true, NOW);
		await store.setDeveloperVideoTakedown(PLAYBACK_ID, false, NOW);

		expect(mocks.store.updates.map((update) => Object.keys(update))).toEqual([
			["metadata"],
			["metadata"],
		]);
		expect(mocks.store.video).toEqual(before);
	});

	it("does nothing when the video is already in the asked state", async () => {
		await store.setDeveloperVideoTakedown(PLAYBACK_ID, true, NOW);
		const again = await store.setDeveloperVideoTakedown(
			PLAYBACK_ID,
			true,
			new Date(NOW.getTime() + 60_000),
		);
		await store.setDeveloperVideoTakedown(PLAYBACK_ID, false, NOW);
		const restoredAgain = await store.setDeveloperVideoTakedown(
			PLAYBACK_ID,
			false,
			NOW,
		);

		expect(again).toMatchObject({
			changed: false,
			takenDownAt: NOW.toISOString(),
		});
		expect(restoredAgain).toMatchObject({ changed: false, takenDown: false });
		expect(mocks.store.updates).toHaveLength(2);
	});

	it("finds no deleted video and nothing for input that is not an id", async () => {
		expect(
			await store.setDeveloperVideoTakedown("not an id!", true),
		).toBeNull();
		mocks.store.video = ready({ deletedAt: NOW });
		expect(await store.setDeveloperVideoTakedown(PLAYBACK_ID, true)).toBeNull();
		expect(mocks.store.updates).toEqual([]);
	});
});

describe("the staff route", () => {
	it("takes a video down and restores it for staff", async () => {
		const down = await admin({ video: PLAYBACK_ID, takenDown: true });
		expect(down.status).toBe(200);
		expect(down.headers.get("cache-control")).toBe("no-store");
		expect((await down.json()).data).toMatchObject({
			videoId: "video-1",
			takenDown: true,
			changed: true,
		});
		expect(
			takedown.developerVideoIsTakenDown({
				metadata: mocks.store.video?.metadata,
			}),
		).toBe(true);

		const restore = await admin({ video: PLAYBACK_ID, takenDown: false });
		expect((await restore.json()).data).toMatchObject({
			takenDown: false,
			changed: true,
		});
		expect(mocks.store.video?.metadata).toBeNull();
	});

	it.each([
		["signed out", null],
		["any other account", { id: "user-2", email: "someone@example.com" }],
	])("refuses %s and changes nothing", async (_, user) => {
		mocks.user = user;

		const response = await admin({ video: PLAYBACK_ID, takenDown: true });

		expect(response.status).toBe(403);
		expect(mocks.store.updates).toEqual([]);
	});

	it.each([
		["a form post", { "content-type": "application/x-www-form-urlencoded" }],
		["a text post", { "content-type": "text/plain" }],
		[
			"JSON from another site",
			{ "content-type": "application/json", origin: "https://evil.example" },
		],
	])("refuses %s before reading the session", async (_, headers) => {
		const response = await admin(
			{ video: PLAYBACK_ID, takenDown: true },
			headers,
		);

		expect(response.status).toBe(400);
		expect(mocks.store.updates).toEqual([]);
	});

	it("accepts JSON from its own origin", async () => {
		const response = await admin(
			{ video: PLAYBACK_ID, takenDown: true },
			{ origin: "https://web.example" },
		);

		expect(response.status).toBe(200);
	});

	it.each([
		["not JSON", "{"],
		["no video", { takenDown: true }],
		["a string flag", { video: PLAYBACK_ID, takenDown: "true" }],
	])("answers 400 for %s", async (_, body) => {
		expect((await admin(body)).status).toBe(400);
	});

	it("answers 404 when no video matches", async () => {
		mocks.store.video = null;

		expect((await admin({ video: PLAYBACK_ID, takenDown: true })).status).toBe(
			404,
		);
	});
});

describe("the staff script", () => {
	const run = async (argv: string[], env: Record<string, string>) => {
		const lines: string[] = [];
		const calls: { url: string; init: RequestInit }[] = [];
		const code = await script.runTakedown({
			argv,
			env,
			fetchImpl: async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return admin(JSON.parse(String(init.body)));
			},
			log: (line: string) => lines.push(line),
			fail: (line: string) => lines.push(`error: ${line}`),
		});
		return { code, lines, calls };
	};

	it("takes a video down and restores it through the staff route", async () => {
		const down = await run(["down", PLAYBACK_ID], {
			CAP_SESSION_TOKEN: "session",
			CAP_URL: "https://web.example/",
		});

		expect(down.code).toBe(0);
		expect(down.calls[0]?.url).toBe(
			"https://web.example/api/admin/developer-video-takedown",
		);
		expect(down.calls[0]?.init.headers).toEqual({
			"Content-Type": "application/json",
			Cookie: "next-auth.session-token=session",
		});
		expect(down.lines).toEqual([
			`video-1 (playback ${PLAYBACK_ID}, app app-1) is taken down.`,
		]);

		const restore = await run(["restore", PLAYBACK_ID], {
			CAP_SESSION_TOKEN: "session",
		});
		expect(restore.calls[0]?.url).toBe(
			"https://cap.so/api/admin/developer-video-takedown",
		);
		expect(restore.lines).toEqual([
			`video-1 (playback ${PLAYBACK_ID}, app app-1) is playing normally.`,
		]);
		expect(mocks.store.video?.metadata).toBeNull();
	});

	it("explains its usage and needs a session", async () => {
		expect((await run(["remove", PLAYBACK_ID], {})).code).toBe(2);
		expect((await run(["down"], {})).code).toBe(2);
		const missing = await run(["down", PLAYBACK_ID], {});
		expect(missing.code).toBe(2);
		expect(missing.calls).toEqual([]);
	});

	it("fails when the route refuses", async () => {
		mocks.user = null;

		const refused = await run(["down", PLAYBACK_ID], {
			CAP_SESSION_TOKEN: "session",
		});

		expect(refused.code).toBe(1);
		expect(refused.lines).toEqual(["error: 403: Not allowed."]);
	});
});

describe("the takedown docs", () => {
	it("promise 410 only for playback files, not for the page or embed", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { developerOpenApiSpec } = await import("@/lib/developer-openapi");
		const docs = readFileSync(
			join(process.cwd(), "content/docs/api/rest-api.mdx"),
			"utf8",
		);
		const described = [
			...docs.split("\n").filter((line) => line.includes("`takenDown`")),
			String(
				developerOpenApiSpec("https://cap.so").components.schemas.DeveloperVideo
					.properties.takenDown.description,
			),
		];

		expect(described.length).toBeGreaterThan(2);
		for (const text of described) {
			expect(text).not.toMatch(/page[^.]*410|embed[^.]*410/i);
		}
	});
});

describe("the developer API", () => {
	const withEnv = () => ready({ metadata: { orderId: 7 } });

	it("reports a taken down video honestly and leaves every other field as it was", async () => {
		mocks.store.video = withEnv();
		const before = api.serializeDeveloperVideo(mocks.store.video);
		const beforeStatus = api.serializeDeveloperVideoStatus(mocks.store.video);
		const agentRow = (row: NonNullable<typeof mocks.store.video>) => ({
			...row,
			takenDown: takedown.developerVideoIsTakenDown(row),
		});
		const beforeAgent = api.toAgentDeveloperVideo(agentRow(mocks.store.video));

		await store.setDeveloperVideoTakedown(PLAYBACK_ID, true, NOW);
		const video = mocks.store.video;
		if (!video) throw new Error("missing video");

		const nulls = { hlsUrl: null, mp4Url: null, posterUrl: null };
		expect(api.serializeDeveloperVideo(video)).toEqual({
			...before,
			...nulls,
			takenDown: true,
		});
		expect(api.serializeDeveloperVideoStatus(video)).toEqual({
			...beforeStatus,
			...nulls,
			takenDown: true,
		});
		expect(api.toAgentDeveloperVideo(agentRow(video))).toEqual({
			...beforeAgent,
			...nulls,
			takenDown: true,
		});
		expect(api.serializeDeveloperVideo(video)).toMatchObject({
			status: "ready",
			metadata: { orderId: 7 },
			shareUrl: `https://web.example/dev/${PLAYBACK_ID}`,
		});
	});

	it("gives the agent API a boolean even when the database answers NULL", () => {
		const row = { ...withEnv(), takenDown: null as unknown as boolean };

		expect(api.toAgentDeveloperVideo(row).takenDown).toBe(false);
	});

	it("adds takenDown false to a regular video and changes nothing else", () => {
		const video = withEnv();
		const serialized = api.serializeDeveloperVideo(video);

		expect(serialized.takenDown).toBe(false);
		expect(serialized.metadata).toEqual({ orderId: 7 });
		expect(serialized.hlsUrl).toBe(
			`https://web.example/api/developer/playback/${PLAYBACK_ID}/master.m3u8`,
		);
		expect(api.serializeDeveloperVideoStatus(video)).toMatchObject({
			ready: true,
			status: "ready",
			takenDown: false,
		});
	});
});

describe("the owner's console", () => {
	const row = (
		takenDown: boolean,
		status: "ready" | "processing" = "ready",
	) => {
		const video = ready({ status });
		return { ...video, legacy: false, takenDown };
	};

	it("shows a taken down video as taken down, not as failed", () => {
		expect(view.infraVideoState(row(true))).toBe("taken_down");
		expect(view.infraVideoState(row(true, "processing"))).toBe("taken_down");
		expect(view.INFRA_VIDEO_DISPLAY_LABELS.taken_down).toBe("Taken down");
		expect(view.infraVideoDisplayState("taken_down", null)).toBe("taken_down");
		expect(
			view.infraVideoIsChanging(
				{ state: "taken_down", createdAt: NOW },
				NOW.getTime(),
			),
		).toBe(false);
	});

	it("offers no page, embed code or failure for a taken down video", () => {
		const detail = view.toInfraVideoDetail(
			row(true),
			{ hlsUrl: null, mp4Url: null, posterUrl: null },
			{
				shareUrl: "https://web.example/dev/x",
				embedUrl: "https://web.example/dev/x/embed",
			},
		);

		expect(detail).toMatchObject({
			state: "taken_down",
			failure: null,
			shareUrl: null,
			embedCode: null,
			stillEncoding: false,
		});
		expect(view.infraVideoState(row(false))).toBe("ready");
	});
});
