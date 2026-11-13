import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { developerVideo, processingState } from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	user: null as null | { id: string; email: string },
	rows: [] as Record<string, unknown>[][],
	selections: [] as Record<string, unknown>[],
	conditions: [] as unknown[],
	redrive: vi.fn(async (_videoId: string) => false),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		const chain = {
			select: (fields: Record<string, unknown>) => {
				mocks.selections.push(fields);
				return chain;
			},
			from: () => chain,
			where: (condition: unknown) => {
				mocks.conditions.push(condition);
				return chain;
			},
			orderBy: () => chain,
			limit: () => {
				const rows = Promise.resolve(mocks.rows.shift() ?? []);
				return Object.assign(rows, { offset: () => rows });
			},
		};
		return chain;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => false }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://web.example",
		INFRA_PLAYBACK_URL: undefined,
	}),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: mocks.redrive,
}));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => null }),
	headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({
	redirect: (path: string) => {
		throw new Error(`redirect:${path}`);
	},
	notFound: () => {
		throw new Error("not-found");
	},
}));

import {
	getDeveloperAppVideo,
	getDeveloperAppVideos,
	getInfraApps,
	requireInfraApp,
} from "@/app/(infra)/dashboard/infra/infra-data";

const dialect = new MySqlDialect();
const query = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

const LIST_FIELDS = [
	"createdAt",
	"duration",
	"externalUserId",
	"id",
	"name",
	"state",
];

beforeEach(() => {
	mocks.user = { id: "user-1", email: "owner@example.com" };
	mocks.rows = [];
	mocks.selections = [];
	mocks.conditions = [];
	mocks.redrive.mockReset();
	mocks.redrive.mockResolvedValue(false);
});

describe("console video list", () => {
	it("reads named columns and never the stored key or processing state", async () => {
		await getDeveloperAppVideos("app-1");

		const [selection] = mocks.selections;
		expect(Object.keys(selection ?? {}).sort()).toEqual([
			"createdAt",
			"duration",
			"externalUserId",
			"id",
			"legacy",
			"name",
			"status",
			"width",
		]);
		expect(query(selection?.legacy).sql).toMatch(
			/`playbackId` IS NULL AND .*`processing` IS NULL/,
		);
	});

	it("sends the browser exactly the fields the pages show", async () => {
		const video = developerVideo({ status: "ready" });
		mocks.rows = [
			[
				{ ...video, legacy: 0 },
				{
					...video,
					id: "video-2",
					status: "uploading",
					playbackId: null,
					processing: null,
					legacy: "1",
				},
				{
					...video,
					id: "video-3",
					status: "uploading",
					duration: null,
					legacy: 0,
				},
				{ ...video, id: "video-4", status: "errored", legacy: 0 },
				{ ...video, id: "video-5", status: "processing", legacy: 0 },
			],
		];

		const videos = await getDeveloperAppVideos("app-1");

		expect(videos.map((item) => item.state)).toEqual([
			"ready",
			"ready",
			"uploading",
			"failed",
			"processing",
		]);
		for (const item of videos) {
			expect(Object.keys(item).sort()).toEqual(LIST_FIELDS);
		}
		expect(JSON.stringify(videos)).not.toContain("developer/app-1");
		expect(JSON.stringify(videos)).not.toContain("encode-1");
	});

	it("scopes the list to the app, live videos and the user id filter", async () => {
		await getDeveloperAppVideos("app-1", { userId: "user_123" });

		const { sql, params } = query(mocks.conditions[0]);
		expect(sql).toContain("`appId` = ?");
		expect(sql).toContain("`deletedAt` is null");
		expect(sql).toContain("`externalUserId` = ?");
		expect(sql).toMatch(
			/CAST\(.*`externalUserId` AS BINARY\) = CAST\(\? AS BINARY\)/,
		);
		expect(params).toEqual(["app-1", "user_123", "user_123"]);
	});
});

describe("console video page", () => {
	it("looks the video up inside the app and skips deleted ones", async () => {
		await expect(getDeveloperAppVideo("app-1", "video-1")).resolves.toBeNull();

		const { sql, params } = query(mocks.conditions[0]);
		expect(sql).toContain("`id` = ?");
		expect(sql).toContain("`appId` = ?");
		expect(sql).toContain("`deletedAt` is null");
		expect(params).toEqual(["video-1", "app-1"]);
		expect(Object.keys(mocks.selections[0] ?? {})).not.toContain("s3Key");
	});

	it("returns playback links for a ready video without its internals", async () => {
		mocks.rows = [
			[
				developerVideo({
					status: "ready",
					storedBytes: 9_000_000,
					processing: processingState({
						hls: { state: "complete", output: "out-hls" },
						mp4: { state: "complete", output: "out-mp4" },
						poster: { output: "out-mp4" },
					}),
				}),
			],
		];

		const video = await getDeveloperAppVideo("app-1", "video-1");

		expect(video).toMatchObject({
			id: "video-1",
			state: "ready",
			storedBytes: 9_000_000,
			hlsUrl:
				"https://web.example/api/developer/playback/playback-id-0123456789ab/master.m3u8",
			stillEncoding: false,
		});
		expect(video?.mp4Url).toBeTruthy();
		expect(video?.posterUrl).toBeTruthy();
		expect(video).not.toHaveProperty("processing");
		expect(video).not.toHaveProperty("playbackId");
		expect(video).not.toHaveProperty("s3Key");
		expect(video).not.toHaveProperty("errorReason");
		expect(JSON.stringify(video)).not.toContain("out-hls");
	});

	it("has no links while a video is still processing", async () => {
		mocks.rows = [[developerVideo({ status: "processing" })]];

		const video = await getDeveloperAppVideo("app-1", "video-1");

		expect(video).toMatchObject({
			state: "processing",
			hlsUrl: null,
			mp4Url: null,
			posterUrl: null,
		});
	});
});

describe("opening a video restarts encoding that is due", () => {
	const mp4Only = (retryAt: number) =>
		developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "out-mp4" },
				hls: { state: "unavailable", reason: "not yet", retryAt },
			}),
		});

	it("retries adaptive streaming once its wait is over and shows the new state", async () => {
		mocks.redrive.mockResolvedValue(true);
		mocks.rows = [
			[mp4Only(Date.now() - 1_000)],
			[
				developerVideo({
					status: "ready",
					processing: processingState({
						mp4: { state: "complete", output: "out-mp4" },
						hls: { state: "pending" },
					}),
				}),
			],
		];

		const video = await getDeveloperAppVideo("app-1", "video-1");

		expect(mocks.redrive).toHaveBeenCalledExactlyOnceWith("video-1");
		expect(mocks.selections).toHaveLength(2);
		expect(video).toMatchObject({ state: "ready", stillEncoding: true });
	});

	it("keeps the row it read when another request took the retry", async () => {
		mocks.rows = [[mp4Only(Date.now() - 1_000)]];

		const video = await getDeveloperAppVideo("app-1", "video-1");

		expect(mocks.redrive).toHaveBeenCalledExactlyOnceWith("video-1");
		expect(mocks.selections).toHaveLength(1);
		expect(video?.mp4Url).toBeTruthy();
	});

	it("leaves a video alone while nothing is due", async () => {
		for (const row of [
			mp4Only(Date.now() + 60 * 60 * 1000),
			developerVideo({ status: "uploading", duration: null }),
			developerVideo({ status: "errored" }),
			developerVideo({
				status: "processing",
				processing: processingState({ startedAt: Date.now() }),
			}),
		]) {
			mocks.rows = [[row]];
			await getDeveloperAppVideo("app-1", "video-1");
		}

		expect(mocks.redrive).not.toHaveBeenCalled();
	});

	it("starts a video whose upload finished but never began encoding", async () => {
		mocks.rows = [
			[
				developerVideo({
					status: "uploading",
					updatedAt: new Date(Date.now() - 10 * 60 * 1000),
				}),
			],
		];

		await getDeveloperAppVideo("app-1", "video-1");

		expect(mocks.redrive).toHaveBeenCalledExactlyOnceWith("video-1");
	});
});

describe("signed-out console visits", () => {
	it("come back to the console after signing in", async () => {
		mocks.user = null;

		await expect(getInfraApps()).rejects.toThrow(
			"redirect:/login?next=%2Fdashboard%2Finfra",
		);
		await expect(requireInfraApp("app-1")).rejects.toThrow(
			"redirect:/login?next=%2Fdashboard%2Finfra%2Fapp-1",
		);
	});
});
