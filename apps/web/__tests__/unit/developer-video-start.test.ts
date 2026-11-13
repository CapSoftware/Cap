import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
	start: vi.fn(),
	claim: vi.fn(),
	release: vi.fn(),
	prepare: vi.fn(),
	dispatch: vi.fn(),
	fail: vi.fn(),
	order: [] as string[],
}));

class Refused extends Error {}

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));
vi.mock("@/lib/developer-video-processing", () => ({
	claimDeveloperVideoProcessing: mocks.claim,
	releaseDeveloperVideoClaim: mocks.release,
	prepareDeveloperVideoProcessing: mocks.prepare,
	dispatchDeveloperVideoParts: mocks.dispatch,
	failDeveloperVideoProcessing: mocks.fail,
	isDeveloperVideoRefusal: (error: unknown) => error instanceof Refused,
}));

const {
	kickStartDeveloperVideo,
	redriveDeveloperVideoProcessing,
	startDeveloperVideoProcessing,
} = await import("@/lib/developer-video-start");

const claim = { action: "start" as const, encodeId: "encode-1" };

async function kicked(): Promise<void> {
	await mocks.after.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.order = [];
	mocks.claim.mockResolvedValue(claim);
	mocks.start.mockImplementation(async () => {
		mocks.order.push("workflow");
	});
	mocks.prepare.mockImplementation(async () => {
		mocks.order.push("prepare");
		return "ready";
	});
	mocks.fail.mockResolvedValue(undefined);
	mocks.dispatch.mockImplementation(async () => {
		mocks.order.push("dispatch");
		return [];
	});
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("developer video start", () => {
	it("starts the workflow, then probes and sends both outputs to the encoder without waiting for it", async () => {
		expect(await startDeveloperVideoProcessing("video-1", claim)).toBe(true);
		await kicked();

		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.start).toHaveBeenCalledWith("workflow", [
			{ videoId: "video-1", encodeId: "encode-1" },
		]);
		expect(mocks.order).toEqual(["workflow", "prepare", "dispatch"]);
		expect(mocks.after).toHaveBeenCalledTimes(1);
	});

	it("keeps the first pass alive past the response, and still runs it outside a request", async () => {
		mocks.after.mockImplementationOnce(() => {
			throw new Error("after() called outside a request scope");
		});

		expect(await startDeveloperVideoProcessing("video-1", claim)).toBe(true);
		await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
	});

	it("hands the source the probe read to the dispatch so it is not read again", async () => {
		const source = { bytes: 1_000, contentType: "video/quicktime" };
		mocks.prepare.mockImplementation(
			async (_video: string, _encode: string, seen: { source?: unknown }) => {
				seen.source = source;
				return "ready";
			},
		);

		await kickStartDeveloperVideo("video-1", "encode-1");

		expect(mocks.dispatch).toHaveBeenCalledWith("video-1", "encode-1", source);
	});

	it("leaves the source unknown when the probe was done before", async () => {
		await kickStartDeveloperVideo("video-1", "encode-1");

		expect(mocks.dispatch).toHaveBeenCalledWith(
			"video-1",
			"encode-1",
			undefined,
		);
	});

	it("waits for the outputs to be sent before the first pass ends", async () => {
		let release: () => void = () => undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.dispatch.mockImplementation(async () => {
			await slow;
			mocks.order.push("dispatch");
			return [];
		});

		let settled = false;
		const kick = kickStartDeveloperVideo("video-1", "encode-1").then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
		await Promise.resolve();

		expect(settled).toBe(false);

		release();
		await kick;

		expect(mocks.order).toContain("dispatch");
	});

	it.each(["retry", "stale", "probing"])(
		"leaves a video whose probe came back %s to the workflow",
		async (prepared) => {
			mocks.prepare.mockResolvedValue(prepared);

			await kickStartDeveloperVideo("video-1", "encode-1");

			expect(mocks.dispatch).not.toHaveBeenCalled();
		},
	);

	it("fails a refused upload straight away with the reason it was given", async () => {
		mocks.prepare.mockRejectedValue(
			new Refused("This file has no video track."),
		);

		await expect(
			kickStartDeveloperVideo("video-1", "encode-1"),
		).resolves.toBeUndefined();

		expect(mocks.fail).toHaveBeenCalledWith(
			"video-1",
			"encode-1",
			"This file has no video track.",
		);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("leaves any other failed first pass to the workflow, which records it", async () => {
		mocks.prepare.mockRejectedValue(new Error("connection reset"));

		await expect(
			kickStartDeveloperVideo("video-1", "encode-1"),
		).resolves.toBeUndefined();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(mocks.fail).not.toHaveBeenCalled();

		mocks.prepare.mockResolvedValue("ready");
		mocks.dispatch.mockRejectedValue(new Error("storage unavailable"));

		await expect(
			kickStartDeveloperVideo("video-1", "encode-1"),
		).resolves.toBeUndefined();
		expect(mocks.fail).not.toHaveBeenCalled();
	});

	it("gives the claim back and starts nothing when the workflow cannot start", async () => {
		mocks.start.mockRejectedValue(new Error("queue down"));

		expect(await startDeveloperVideoProcessing("video-1", claim)).toBe(false);

		expect(mocks.release).toHaveBeenCalledWith("video-1", claim);
		expect(mocks.after).not.toHaveBeenCalled();
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("does nothing when a redrive finds nothing to claim", async () => {
		mocks.claim.mockResolvedValue(null);

		expect(await redriveDeveloperVideoProcessing("video-1")).toBe(false);

		expect(mocks.claim).toHaveBeenCalledWith("video-1", {});
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.after).not.toHaveBeenCalled();
	});

	it("runs the same first pass for a redrive it claimed", async () => {
		mocks.claim.mockResolvedValue({
			action: "retry-hls",
			encodeId: "encode-9",
		});

		expect(await redriveDeveloperVideoProcessing("video-1")).toBe(true);
		await kicked();

		expect(mocks.prepare).toHaveBeenCalledWith("video-1", "encode-9", {});
		expect(mocks.dispatch.mock.calls).toEqual([
			["video-1", "encode-9", undefined],
		]);
	});
});
