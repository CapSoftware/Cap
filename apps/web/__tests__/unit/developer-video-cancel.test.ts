import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processingState } from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	cancelJob: vi.fn(),
	rows: [] as { id: string; processing: unknown }[],
	where: [] as unknown[],
	readFails: false,
}));

vi.mock("@/lib/media-client", () => ({
	cancelMediaServerVideoJob: mocks.cancelJob,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async (condition: unknown) => {
					mocks.where.push(condition);
					if (mocks.readFails) throw new Error("database unavailable");
					return mocks.rows;
				},
			}),
		}),
	}),
}));

const {
	cancelDeveloperVideoEncodes,
	cancelDeveloperVideoJobs,
	runningDeveloperVideoJobIds,
} = await import("@/lib/developer-video-cancel");

const running = (jobId: string | null) => ({
	state: "running" as const,
	token: `t-${jobId}`,
	jobId,
	startedAt: 2_000,
});

const whereSql = () => {
	const [condition] = mocks.where;
	return new MySqlDialect().sqlToQuery(
		condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
	);
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [];
	mocks.where = [];
	mocks.readFails = false;
	mocks.cancelJob.mockResolvedValue("cancelled");
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("runningDeveloperVideoJobIds", () => {
	it("returns the job of every running part", () => {
		expect(
			runningDeveloperVideoJobIds(
				processingState({ hls: running("job-hls"), mp4: running("job-mp4") }),
			).sort(),
		).toEqual(["job-hls", "job-mp4"]);
	});

	it("skips parts with no job id and parts that are not running", () => {
		expect(
			runningDeveloperVideoJobIds(
				processingState({
					hls: running(null),
					mp4: { state: "complete", output: "mp4-out" },
				}),
			),
		).toEqual([]);
		expect(
			runningDeveloperVideoJobIds(
				processingState({
					hls: { state: "failed", reason: "no" },
					mp4: { state: "pending" },
				}),
			),
		).toEqual([]);
		expect(runningDeveloperVideoJobIds(null)).toEqual([]);
	});
});

describe("cancelDeveloperVideoJobs", () => {
	it("cancels every job at once", async () => {
		const pending: (() => void)[] = [];
		mocks.cancelJob.mockImplementation(
			() =>
				new Promise((resolve) => {
					pending.push(() => resolve("cancelled"));
				}),
		);

		const done = cancelDeveloperVideoJobs("video-1", ["job-1", "job-2"]);
		await vi.waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledTimes(2));
		for (const resolve of pending) resolve();
		await done;
	});

	it("warns only when a cancel could not be delivered", async () => {
		mocks.cancelJob.mockImplementation(async (jobId: string) =>
			jobId === "job-1" ? "failed" : jobId === "job-2" ? "finished" : "missing",
		);

		await cancelDeveloperVideoJobs("video-1", ["job-1", "job-2", "job-3"]);

		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"[developer-video] Could not cancel encode job",
			{ videoId: "video-1", jobId: "job-1" },
		);
	});

	it("does nothing without a job id", async () => {
		await cancelDeveloperVideoJobs("video-1", []);

		expect(mocks.cancelJob).not.toHaveBeenCalled();
	});
});

describe("cancelDeveloperVideoEncodes", () => {
	it("reads one deleted video of the app and cancels its running jobs", async () => {
		mocks.rows = [
			{
				id: "video-1",
				processing: processingState({
					hls: running("job-hls"),
					mp4: running(null),
				}),
			},
		];

		await cancelDeveloperVideoEncodes({ appId: "app-1", videoId: "video-1" });

		const query = whereSql();
		expect(query.sql).toContain("`developer_videos`.`appId` = ?");
		expect(query.sql).toContain("`developer_videos`.`id` = ?");
		expect(query.sql).toContain("`developer_videos`.`deletedAt` is not null");
		expect(query.params).toEqual(["app-1", "video-1"]);
		expect(mocks.cancelJob.mock.calls).toEqual([["job-hls"]]);
	});

	it("reads only the videos the app delete just removed that still have a running part", async () => {
		mocks.rows = [
			{ id: "video-1", processing: processingState({ hls: running("job-1") }) },
			{ id: "video-2", processing: processingState({ mp4: running("job-2") }) },
		];

		await cancelDeveloperVideoEncodes({
			appId: "app-1",
			deletedAt: new Date("2026-11-13T06:00:00.750Z"),
		});

		const query = whereSql();
		expect(query.sql).toContain(
			"JSON_UNQUOTE(JSON_EXTRACT(`developer_videos`.`processing`, '$.hls.state')) = 'running'",
		);
		expect(query.sql).toContain(
			"JSON_UNQUOTE(JSON_EXTRACT(`developer_videos`.`processing`, '$.mp4.state')) = 'running'",
		);
		expect(query.sql).toContain("`developer_videos`.`deletedAt` is not null");
		expect(query.sql).toContain("`developer_videos`.`deletedAt` >= ?");
		expect(query.params).toEqual(["app-1", "2026-11-13 06:00:00.000"]);
		expect(mocks.cancelJob.mock.calls.flat().sort()).toEqual([
			"job-1",
			"job-2",
		]);
	});

	it("never fails the delete when the jobs cannot be read", async () => {
		mocks.readFails = true;

		await expect(
			cancelDeveloperVideoEncodes({ appId: "app-1", videoId: "video-1" }),
		).resolves.toBeUndefined();
		expect(mocks.cancelJob).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[developer-video] Could not cancel encode jobs",
			expect.objectContaining({ appId: "app-1", videoId: "video-1" }),
		);
	});
});
