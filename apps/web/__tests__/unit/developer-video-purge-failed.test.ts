import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoFixture,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const START = "m";

const mocks = vi.hoisted(() => ({
	videos: [] as DeveloperVideoFixture[],
	queries: [] as string[],
	deleteObjects: vi.fn(),
}));

const FAILED_AND_DUE =
	"`developer_videos`.`status` = ? and `developer_videos`.`filesDeletedAt` is null and `developer_videos`.`deletedAt` is null and JSON_EXTRACT(`developer_videos`.`processing`, '$.startedAt') <= ?";

function matching(where: unknown) {
	const { sql, params } = new MySqlDialect().sqlToQuery(where as never);
	mocks.queries.push(sql);
	const [status, startedBefore, cursor] = params as [string, number, string];
	const inRange = (id: string) => {
		if (sql === `(${FAILED_AND_DUE} and \`developer_videos\`.\`id\` > ?)`) {
			return id > cursor;
		}
		if (sql === `(${FAILED_AND_DUE} and \`developer_videos\`.\`id\` <= ?)`) {
			return id <= cursor;
		}
		throw new Error(`Unexpected purge query: ${sql}`);
	};
	return mocks.videos
		.filter(
			(video) =>
				video.status === status &&
				video.filesDeletedAt === null &&
				video.deletedAt === null &&
				video.processing !== null &&
				video.processing.startedAt <= startedBefore &&
				inRange(video.id),
		)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: (where: unknown) => ({
					orderBy: () => ({
						limit: async (limit: number) =>
							matching(where)
								.slice(0, limit)
								.map(({ id, appId }) => ({ id, appId })),
					}),
				}),
			}),
		}),
		update: () => ({
			set: (set: Partial<DeveloperVideoFixture>) => ({
				where: async (where: unknown) => {
					const { params } = new MySqlDialect().sqlToQuery(where as never);
					mocks.videos = mocks.videos.map((video) =>
						video.id === params[0] ? { ...video, ...set } : video,
					);
				},
			}),
		}),
	}),
}));
vi.mock("@/lib/developer-video-storage", () => ({
	deleteDeveloperVideoObjects: mocks.deleteObjects,
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
}));

const { FAILED_VIDEO_FILES_KEPT_MS, purgeFailedDeveloperVideoFiles } =
	await import("@/lib/developer-video-purge");

const failedParts = {
	hls: { state: "failed" as const, reason: "x" },
	mp4: { state: "failed" as const, reason: "x" },
	attempts: { hls: 2, mp4: 2 },
};

const video = (
	id: string,
	startedHoursAgo: number,
	overrides: Partial<DeveloperVideoFixture> = {},
) =>
	developerVideo({
		id,
		status: "errored",
		errorReason: "This file has no video track.",
		storedBytes: 5_000_000,
		processing: processingState({
			...failedParts,
			startedAt: NOW - startedHoursAgo * HOUR,
		}),
		...overrides,
	});

const stored = (id: string) => mocks.videos.find((row) => row.id === id);
const purgedFolders = () =>
	mocks.deleteObjects.mock.calls.map(([prefix]) => prefix);
const purge = (limit?: number) =>
	purgeFailedDeveloperVideoFiles(limit, NOW, START);

beforeEach(() => {
	mocks.videos = [];
	mocks.queries = [];
	mocks.deleteObjects.mockReset();
	mocks.deleteObjects.mockResolvedValue(3);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("failed developer video file purge", () => {
	it("keeps a failed video's files for 24 hours", () => {
		expect(FAILED_VIDEO_FILES_KEPT_MS).toBe(24 * HOUR);
	});

	it("removes the files once the video has been failed for a day, and not before", async () => {
		mocks.videos = [
			video("a-due", 24),
			video("b-just-short", 23.99),
			video("c-fresh", 1),
			video("z-long-due", 24 * 30),
		];

		expect(await purge()).toEqual({ purged: 2, failed: 0 });
		expect(purgedFolders().sort()).toEqual([
			"developer/app-1/a-due/",
			"developer/app-1/z-long-due/",
		]);
		expect(stored("b-just-short")?.filesDeletedAt).toBeNull();
		expect(stored("c-fresh")?.filesDeletedAt).toBeNull();
	});

	it("keeps the row and its reason, and reports nothing stored", async () => {
		mocks.videos = [video("a-due", 48)];

		await purge();

		expect(stored("a-due")).toMatchObject({
			status: "errored",
			errorReason: "This file has no video track.",
			deletedAt: null,
			storedBytes: 0,
			playbackId: "playback-id-0123456789ab",
		});
		expect(stored("a-due")?.filesDeletedAt).toBeInstanceOf(Date);
		expect(stored("a-due")?.processing).toMatchObject(failedParts);
	});

	it("purges a failed video once", async () => {
		mocks.videos = [video("a-due", 48)];

		await purge();
		expect(await purge()).toEqual({ purged: 0, failed: 0 });
		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a ready video", { status: "ready" as const }],
		["a video still processing", { status: "processing" as const }],
		["a video still uploading", { status: "uploading" as const }],
		[
			"a failed video that was deleted, which the deleted purge handles",
			{ deletedAt: new Date(NOW - 30 * HOUR) },
		],
		[
			"a failed video whose files are already gone",
			{ filesDeletedAt: new Date(NOW - HOUR) },
		],
	])("leaves %s alone however old it is", async (_, overrides) => {
		mocks.videos = [video("a-old", 24 * 30, overrides)];
		const before = structuredClone(mocks.videos);

		expect(await purge()).toEqual({ purged: 0, failed: 0 });
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.videos).toEqual(before);
	});

	it("leaves the files in place to try again when storage fails", async () => {
		mocks.videos = [video("a-due", 48), video("b-due", 48)];
		mocks.deleteObjects.mockRejectedValueOnce(new Error("storage down"));

		expect(await purge()).toEqual({ purged: 1, failed: 1 });
		expect(stored("a-due")).toMatchObject({
			filesDeletedAt: null,
			storedBytes: 5_000_000,
		});
		expect(stored("b-due")?.filesDeletedAt).toBeInstanceOf(Date);
	});

	it("stops taking videos once its minute is up and leaves the rest for a later run", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			mocks.videos = [
				video("n-due", 48),
				video("o-due", 48),
				video("p-due", 48),
			];
			mocks.deleteObjects.mockImplementation(async () => {
				vi.setSystemTime(Date.now() + 40_000);
				return 3;
			});

			expect(await purge()).toEqual({ purged: 2, failed: 0 });
			expect(stored("p-due")).toMatchObject({
				filesDeletedAt: null,
				storedBytes: 5_000_000,
			});

			expect(await purge()).toEqual({ purged: 1, failed: 0 });
			expect(stored("p-due")?.filesDeletedAt).toBeInstanceOf(Date);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up on a deletion that hangs, leaves that video unmarked and moves on", async () => {
		vi.useFakeTimers();
		try {
			mocks.videos = [video("n-due", 48), video("o-due", 48)];
			mocks.deleteObjects.mockImplementationOnce(() => new Promise(() => {}));

			const run = purge();
			await vi.advanceTimersByTimeAsync(20_000);

			expect(await run).toEqual({ purged: 1, failed: 1 });
			expect(stored("n-due")).toMatchObject({
				filesDeletedAt: null,
				storedBytes: 5_000_000,
			});
			expect(stored("o-due")?.filesDeletedAt).toBeInstanceOf(Date);
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts after the given video and wraps around to the ones before it", async () => {
		mocks.videos = [video("a-due", 48), video("n-due", 48), video("z-due", 48)];

		expect(await purge()).toEqual({ purged: 3, failed: 0 });
		expect(purgedFolders()).toEqual([
			"developer/app-1/n-due/",
			"developer/app-1/z-due/",
			"developer/app-1/a-due/",
		]);
	});

	it("does not ask for the earlier videos once the batch is full", async () => {
		mocks.videos = [video("a-due", 48), video("n-due", 48), video("z-due", 48)];

		expect(await purge(2)).toEqual({ purged: 2, failed: 0 });
		expect(purgedFolders()).toEqual([
			"developer/app-1/n-due/",
			"developer/app-1/z-due/",
		]);
		expect(mocks.queries).toHaveLength(1);
	});

	it("fills the rest of the batch from the earlier videos", async () => {
		mocks.videos = [video("a-due", 48), video("b-due", 48), video("n-due", 48)];

		expect(await purge(2)).toEqual({ purged: 2, failed: 0 });
		expect(purgedFolders()).toEqual([
			"developer/app-1/n-due/",
			"developer/app-1/a-due/",
		]);
		expect(stored("b-due")?.filesDeletedAt).toBeNull();
	});
});
