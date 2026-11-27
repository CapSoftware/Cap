import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	etags: [] as Array<string | undefined>,
	probe: vi.fn(),
	record: vi.fn(),
}));

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("next/server", () => ({ after: (task: () => unknown) => task() }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	const bucket = {
		headObject: () => Effect.succeed({ ETag: mocks.etags.shift() }),
		getInternalSignedObjectUrl: () => Effect.succeed("https://storage/obj"),
	};
	return { Storage: { getAccessForVideo: () => Effect.succeed([bucket]) } };
});
vi.mock("@/lib/workflow-runtime", async () => ({
	runWorkflowPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	tryProbeVideoViaMediaServer: mocks.probe,
}));
vi.mock("@/lib/free-plan-duration", () => ({
	exceedsFreePlanMeasuredDuration: (seconds: number | null) =>
		(seconds ?? 0) > 330,
	measuredMediaSeconds: (metadata: { duration: number }) => metadata.duration,
}));
vi.mock("@/lib/free-plan-measure", () => ({
	loadLimitedVideo: async () => ({
		id: "video-1",
		ownerId: "owner-1",
		source: { type: "webMP4" },
		metadata: null,
	}),
	measureHoldsVideo: () => false,
	needsFreePlanMeasure: () => true,
	readFreePlanMeasure: () => null,
	recordFreePlanMeasure: mocks.record,
}));

import { measureFreePlanObject } from "@/lib/free-plan-measure-probe";

const videoId = "video-1" as Video.VideoId;
const key = "owner-1/video-1/result.mp4";

beforeEach(() => {
	mocks.etags = [];
	mocks.probe.mockReset();
	mocks.record.mockReset();
	mocks.probe.mockResolvedValue({ status: "ok", metadata: { duration: 400 } });
});

describe("free plan measure identity", () => {
	it("restores a completed upload's length without probing it again", async () => {
		mocks.etags = ['"a"', '"a"'];
		await measureFreePlanObject(videoId, key, {
			fresh: true,
			identity: '"a"',
		});
		await measureFreePlanObject(videoId, key, {
			fresh: true,
			identity: '"a"',
		});
		expect(mocks.probe).toHaveBeenCalledTimes(1);
	});

	it("never remembers a length under an upload that was replaced before it was probed", async () => {
		const replaced = "owner-1/video-1/raw-upload.mp4";
		mocks.etags = ['"b"', '"b"', '"a"', '"a"'];
		await measureFreePlanObject(videoId, replaced, {
			fresh: true,
			identity: '"a"',
		});
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 200 },
		});
		const outcome = await measureFreePlanObject(videoId, replaced, {
			fresh: true,
			identity: '"a"',
		});
		expect(mocks.probe).toHaveBeenCalledTimes(2);
		expect(outcome).toEqual({ kind: "measured", seconds: 200 });
	});

	it("never remembers a length when the object changed during the probe", async () => {
		const changed = "owner-1/video-1/raw-upload.webm";
		mocks.etags = ['"a"', '"b"', '"a"', '"a"'];
		await measureFreePlanObject(videoId, changed, {
			fresh: true,
			identity: '"a"',
		});
		await measureFreePlanObject(videoId, changed, {
			fresh: true,
			identity: '"a"',
		});
		expect(mocks.probe).toHaveBeenCalledTimes(2);
	});
});
