import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sleep: vi.fn(),
	prepare: vi.fn(),
	readParts: vi.fn(),
	dispatch: vi.fn(),
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

	it("tries an unclear probe error a few times, then says the file could not be opened", async () => {
		mocks.prepare.mockResolvedValue("unclear");

		expect(await run()).toEqual({ success: false });

		expect(mocks.prepare).toHaveBeenCalledTimes(4);
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
});
