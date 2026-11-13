import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	user: null as { id: string; email: string } | null,
	settleAtDelete: vi.fn(),
	cancelEncodes: vi.fn(),
	deleteObjects: vi.fn(),
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
vi.mock("@/lib/infra-storage-minimum", () => ({
	settleFirstMonthAtDelete: mocks.settleAtDelete,
}));
vi.mock("@/lib/developer-video-cancel", () => ({
	cancelDeveloperVideoEncodes: mocks.cancelEncodes,
}));
vi.mock("@/lib/developer-video-storage", () => ({
	deleteDeveloperVideoObjects: mocks.deleteObjects,
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
}));

const { POST } = await import("@/app/api/admin/developer-video-takedown/route");
const purge = await import("@/lib/developer-video-purge");
const takedown = await import("@/lib/developer-video-takedown");
const script = await import("../../../../scripts/infra-video-takedown");

const PLAYBACK_ID = "playback-id-0123456789ab";
const STAFF = { id: "staff-user", email: "richie@cap.so" };

const ready = () =>
	developerVideo({
		status: "ready",
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
		}),
	});

const admin = (body: unknown, headers: Record<string, string> = {}) =>
	POST(
		new Request("https://web.example/api/admin/developer-video-takedown", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);

beforeEach(() => {
	mocks.store.video = ready();
	mocks.store.more = [];
	mocks.store.updates = [];
	mocks.store.appDeleted = false;
	mocks.user = STAFF;
	mocks.settleAtDelete.mockReset();
	mocks.cancelEncodes.mockReset();
	mocks.deleteObjects.mockReset();
	mocks.deleteObjects.mockResolvedValue(6);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("staff delete", () => {
	it("takes the video down, deletes it as its owner would and purges its files at once", async () => {
		const response = await admin({ video: PLAYBACK_ID, delete: true });

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect((await response.json()).data).toEqual({
			videoId: "video-1",
			appId: "app-1",
			playbackId: PLAYBACK_ID,
			alreadyDeleted: false,
			filesPurged: true,
		});
		expect(mocks.store.updates.map((update) => Object.keys(update))).toEqual([
			["metadata"],
			["deletedAt"],
			["filesDeletedAt"],
		]);
		const video = mocks.store.video;
		expect(
			takedown.developerVideoIsTakenDown({ metadata: video?.metadata }),
		).toBe(true);
		expect(video?.deletedAt).toBeInstanceOf(Date);
		expect(video?.filesDeletedAt).toBeInstanceOf(Date);
		expect(mocks.settleAtDelete.mock.calls).toEqual([["video-1"]]);
		expect(mocks.cancelEncodes.mock.calls).toEqual([
			[{ appId: "app-1", videoId: "video-1" }],
		]);
		expect(mocks.deleteObjects.mock.calls).toEqual([
			["developer/app-1/video-1/"],
		]);
		expect(console.info).toHaveBeenCalledWith(
			"[developer-video] Deleted by staff",
			{
				by: "staff-user",
				videoId: "video-1",
				alreadyDeleted: false,
				filesPurged: true,
			},
		);
	});

	it("settles and cancels only once when asked again, and purges again", async () => {
		await admin({ video: PLAYBACK_ID, delete: true });
		const again = await admin({ video: PLAYBACK_ID, delete: true });

		expect((await again.json()).data).toMatchObject({
			alreadyDeleted: true,
			filesPurged: true,
		});
		expect(mocks.settleAtDelete).toHaveBeenCalledTimes(1);
		expect(mocks.cancelEncodes).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObjects.mock.calls).toEqual([
			["developer/app-1/video-1/"],
			["developer/app-1/video-1/"],
		]);
	});

	it("purges a video its owner already deleted without billing it again", async () => {
		mocks.store.video = { ...ready(), deletedAt: new Date() };

		const response = await admin({ video: "video-1", delete: true });

		expect((await response.json()).data).toMatchObject({
			alreadyDeleted: true,
			filesPurged: true,
		});
		expect(mocks.settleAtDelete).not.toHaveBeenCalled();
		expect(mocks.cancelEncodes).not.toHaveBeenCalled();
		expect(mocks.store.updates.map((update) => Object.keys(update))).toEqual([
			["filesDeletedAt"],
		]);
	});

	it.each([
		["a video id", "video-1"],
		["the hosted page", `https://cap.so/dev/${PLAYBACK_ID}`],
	])("finds the video from %s", async (_, input) => {
		const response = await admin({ video: input, delete: true });

		expect((await response.json()).data.videoId).toBe("video-1");
	});

	it.each([
		["no video", null],
		["input that is not an id", "not an id!"],
	])("answers 404 for %s and deletes nothing", async (_, input) => {
		if (input === null) mocks.store.video = null;

		const response = await admin({
			video: input ?? PLAYBACK_ID,
			delete: true,
		});

		expect(response.status).toBe(404);
		expect(mocks.store.updates).toEqual([]);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("keeps the delete and leaves the files to the purge job when storage fails", async () => {
		mocks.deleteObjects.mockRejectedValueOnce(new Error("storage down"));

		const response = await admin({ video: PLAYBACK_ID, delete: true });

		expect(response.status).toBe(200);
		expect((await response.json()).data.filesPurged).toBe(false);
		expect(mocks.store.video?.deletedAt).toBeInstanceOf(Date);
		expect(mocks.store.video?.filesDeletedAt).toBeNull();
	});

	it.each([
		["signed out", null, {}],
		[
			"a signed-in account that is not staff",
			{ id: "user-2", email: "someone@example.com" },
			{},
		],
		[
			"an Infra secret key sent as Bearer",
			null,
			{ authorization: "Bearer cap_sk_live_0123456789abcdef" },
		],
	])("refuses %s and touches nothing", async (_, user, headers) => {
		mocks.user = user;

		const response = await admin({ video: PLAYBACK_ID, delete: true }, headers);

		expect(response.status).toBe(403);
		expect(mocks.store.updates).toEqual([]);
		expect(mocks.settleAtDelete).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it.each([
		["JSON from another site", { origin: "https://evil.example" }],
		["a form post", { "content-type": "application/x-www-form-urlencoded" }],
	])("refuses %s before reading the session", async (_, headers) => {
		const response = await admin({ video: PLAYBACK_ID, delete: true }, headers);

		expect(response.status).toBe(400);
		expect(mocks.store.updates).toEqual([]);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("leaves the takedown contract as it was when delete is not true", async () => {
		const response = await admin({ video: PLAYBACK_ID, delete: "yes" });

		expect(response.status).toBe(400);
		expect(mocks.store.updates).toEqual([]);
	});
});

describe("the immediate purge", () => {
	it.each([
		["an empty video id", { appId: "app-1", id: "" }],
		["an empty app id", { appId: "", id: "video-1" }],
		["a video id that climbs out", { appId: "app-1", id: ".." }],
		["a video id with a slash", { appId: "app-1", id: "video-1/hls" }],
		["an app id with a slash", { appId: "app-1/video-1", id: "x" }],
	])("refuses %s and deletes nothing", async (_, row) => {
		expect(() => purge.developerVideoPurgePrefix(row)).toThrow(
			/Refusing to purge/,
		);
		await expect(purge.purgeDeletedDeveloperVideoNow(row)).rejects.toThrow(
			/Refusing to purge/,
		);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.store.updates).toEqual([]);
	});

	it("deletes only that video's folder", async () => {
		expect(
			await purge.purgeDeletedDeveloperVideoNow({
				appId: "app-1",
				id: "video-1",
			}),
		).toBe(true);
		expect(mocks.deleteObjects.mock.calls).toEqual([
			["developer/app-1/video-1/"],
		]);
	});
});

describe("the staff script", () => {
	const run = async (argv: string[]) => {
		const lines: string[] = [];
		const calls: { url: string; body: unknown }[] = [];
		const code = await script.runTakedown({
			argv,
			env: { CAP_SESSION_TOKEN: "session" },
			fetchImpl: async (url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body));
				calls.push({ url, body });
				return admin(body);
			},
			log: (line: string) => lines.push(line),
			fail: (line: string) => lines.push(`error: ${line}`),
		});
		return { code, lines, calls };
	};

	it("deletes through the staff route", async () => {
		const deleted = await run(["delete", PLAYBACK_ID]);

		expect(deleted.code).toBe(0);
		expect(deleted.calls).toEqual([
			{
				url: "https://cap.so/api/admin/developer-video-takedown",
				body: { video: PLAYBACK_ID, delete: true },
			},
		]);
		expect(deleted.lines).toEqual([
			`video-1 (playback ${PLAYBACK_ID}, app app-1) is deleted, and its files are removed.`,
		]);
	});

	it("fails when the files could not be removed yet", async () => {
		mocks.deleteObjects.mockRejectedValueOnce(new Error("storage down"));

		const deleted = await run(["delete", PLAYBACK_ID]);

		expect(deleted.code).toBe(1);
		expect(deleted.lines[0]).toMatch(/purge job will retry/);
	});
});
