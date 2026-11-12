import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sleep: vi.fn(),
	prepare: vi.fn(),
	readParts: vi.fn(),
	dispatch: vi.fn(),
	check: vi.fn(),
	fail: vi.fn(),
	sweep: vi.fn(),
}));

class Refused extends Error {}

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
	sleep: mocks.sleep,
}));
vi.mock("@/lib/developer-video-processing", () => ({
	prepareDeveloperVideoProcessing: mocks.prepare,
	readDeveloperVideoParts: mocks.readParts,
	dispatchDeveloperVideoPart: mocks.dispatch,
	checkDeveloperVideoPart: mocks.check,
	failDeveloperVideoProcessing: mocks.fail,
	sweepSupersededDeveloperVideoOutputs: mocks.sweep,
	isDeveloperVideoRefusal: (error: unknown) => error instanceof Refused,
}));

const { processDeveloperVideoWorkflow } = await import(
	"@/workflows/process-developer-video"
);

const run = () =>
	processDeveloperVideoWorkflow({ videoId: "video-1", encodeId: "encode-1" });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sleep.mockResolvedValue(undefined);
	mocks.fail.mockResolvedValue(undefined);
	mocks.sweep.mockResolvedValue(0);
	mocks.dispatch.mockResolvedValue("dispatched");
	mocks.check.mockResolvedValue("waiting");
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("process developer video workflow", () => {
	it("records a refusal once, in its own words, and sends nothing to the encoder", async () => {
		mocks.prepare.mockRejectedValue(
			new Refused("This file has no video track."),
		);

		expect(await run()).toEqual({ success: false });

		expect(mocks.prepare).toHaveBeenCalledTimes(1);
		expect(mocks.fail.mock.calls).toEqual([
			["video-1", "encode-1", "This file has no video track."],
		]);
		expect(mocks.readParts).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it("reports an unexpected failure as a problem on our side, without its details", async () => {
		mocks.prepare.mockRejectedValue(
			new Error("ER_LOCK_DEADLOCK: Deadlock found on developer_videos"),
		);

		await expect(run()).rejects.toThrow("ER_LOCK_DEADLOCK");

		expect(mocks.fail.mock.calls).toEqual([
			[
				"video-1",
				"encode-1",
				"Processing failed because of a problem on our side. Upload the video again.",
			],
		]);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("stops quietly when the video was already failed or replaced", async () => {
		mocks.prepare.mockResolvedValue("stale");

		expect(await run()).toEqual({ success: false });

		expect(mocks.fail).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("gives an unclear probe error about ten minutes to clear, then says the file could not be opened", async () => {
		mocks.prepare.mockResolvedValue("unclear");

		expect(await run()).toEqual({ success: false });

		expect(mocks.prepare).toHaveBeenCalledTimes(6);
		expect(mocks.sleep.mock.calls.map(([wait]) => wait)).toEqual([
			"20s",
			"40s",
			"80s",
			"160s",
			"320s",
		]);
		expect(mocks.fail.mock.calls).toEqual([
			[
				"video-1",
				"encode-1",
				"The uploaded file could not be opened. Upload it again.",
			],
		]);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("carries on when an unclear probe error clears up", async () => {
		mocks.prepare
			.mockResolvedValueOnce("unclear")
			.mockResolvedValueOnce("unclear")
			.mockResolvedValue("ready");
		mocks.readParts
			.mockResolvedValueOnce({ mp4: "dispatch", hls: "dispatch" })
			.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.fail).not.toHaveBeenCalled();
		expect(mocks.dispatch).toHaveBeenCalledTimes(2);
		expect(mocks.sweep).toHaveBeenCalledWith("video-1", "encode-1");
	});

	it("checks again quickly while another caller is probing", async () => {
		mocks.prepare.mockResolvedValueOnce("probing").mockResolvedValue("ready");
		mocks.readParts.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.sleep.mock.calls[0]).toEqual(["2s"]);
	});

	it("only waits when no running job has gone quiet", async () => {
		mocks.prepare.mockResolvedValue("ready");
		mocks.readParts
			.mockResolvedValueOnce({ mp4: "wait", hls: "wait" })
			.mockResolvedValueOnce({ mp4: "wait", hls: "wait" })
			.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.check).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("asks about a quiet job and sends it again once it is found to be lost", async () => {
		mocks.prepare.mockResolvedValue("ready");
		mocks.check.mockResolvedValue("requeued");
		mocks.readParts
			.mockResolvedValueOnce({ mp4: "wait", hls: "check" })
			.mockResolvedValueOnce({ mp4: "wait", hls: "dispatch" })
			.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.check.mock.calls).toEqual([["video-1", "encode-1", "hls"]]);
		expect(mocks.dispatch.mock.calls).toEqual([["video-1", "encode-1", "hls"]]);
		expect(mocks.fail).not.toHaveBeenCalled();
	});

	it("keeps watching a ready video whose other output has gone quiet", async () => {
		mocks.prepare.mockResolvedValue("ready");
		mocks.check.mockResolvedValue("requeued");
		mocks.readParts
			.mockResolvedValueOnce({ mp4: "done", hls: "check" })
			.mockResolvedValueOnce({ mp4: "done", hls: "dispatch" })
			.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.check.mock.calls).toEqual([["video-1", "encode-1", "hls"]]);
		expect(mocks.dispatch.mock.calls).toEqual([["video-1", "encode-1", "hls"]]);
		expect(mocks.sweep).toHaveBeenCalledTimes(1);
	});

	it("does not fail the video when asking about a quiet job goes wrong", async () => {
		mocks.prepare.mockResolvedValue("ready");
		mocks.check
			.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
			.mockResolvedValueOnce("unreachable")
			.mockResolvedValue("settled");
		mocks.readParts
			.mockResolvedValueOnce({ mp4: "check", hls: "check" })
			.mockResolvedValueOnce({ mp4: "check", hls: "done" })
			.mockResolvedValue({ mp4: "done", hls: "done" });

		expect(await run()).toEqual({ success: true });

		expect(mocks.check).toHaveBeenCalledTimes(3);
		expect(mocks.fail).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("still stops at the three hour deadline when a quiet job never answers", async () => {
		mocks.prepare.mockResolvedValue("ready");
		mocks.check.mockResolvedValue("unreachable");
		mocks.readParts.mockResolvedValue({ mp4: "check", hls: "check" });
		const started = Date.now();
		let waited = 0;
		const now = vi
			.spyOn(Date, "now")
			.mockImplementation(() => started + waited * 1000);
		mocks.sleep.mockImplementation(async (wait: string) => {
			waited += Number.parseInt(wait, 10);
		});

		const result = await run();
		now.mockRestore();

		expect(result).toEqual({ success: true });
		expect(waited).toBeGreaterThanOrEqual(3 * 60 * 60);
		expect(waited).toBeLessThan(3 * 60 * 60 + 60);
		expect(mocks.fail.mock.calls).toEqual([
			[
				"video-1",
				"encode-1",
				"Processing took too long and was stopped. Upload the video again.",
			],
		]);
	});
});
