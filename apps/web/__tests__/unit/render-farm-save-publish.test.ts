import type { Video } from "@cap/web-domain";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	video: null as null | Record<string, unknown>,
	updates: [] as unknown[],
	refreshPreviews: vi.fn(),
	invalidate: vi.fn(async () => {}),
}));

vi.mock("@cap/database", () => {
	const select = () => ({
		from: () => ({
			where: () =>
				Object.assign(Promise.resolve([mocks.video]), {
					for: async () => [mocks.video],
				}),
		}),
	});
	return {
		db: () => ({
			select,
			transaction: async (run: (tx: unknown) => Promise<unknown>) =>
				run({
					select,
					update: () => ({
						set: (values: Record<string, unknown>) => ({
							where: async () => {
								mocks.updates.push(values);
							},
						}),
					}),
				}),
		}),
	};
});
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/export-ready", () => ({ ExportReady: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", () => ({
	runPromise: async () => ({ ContentLength: 100 }),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	retireDesktopRecordingJobForOutputReplacement: vi.fn(),
}));
vi.mock("@/lib/desktop-reupload", () => ({
	invalidateReuploadedVideo: mocks.invalidate,
}));
vi.mock("@/lib/refresh-preview-assets", () => ({
	enqueuePreviewAssetsRefresh: mocks.refreshPreviews,
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: vi.fn(),
	shouldQueueTranscriptionAfterMultipartComplete: () => false,
}));
vi.mock("@/lib/render-farm-records", () => ({
	changeRenderFarmExports: vi.fn(),
	clearRecordingRender: vi.fn(),
	failRenderFarmSave: vi.fn(),
}));
vi.mock("@/lib/render-farm", () => ({
	renderFarmConfig: () => null,
	renderFarmFetch: vi.fn(),
	mapRenderFarmJob: vi.fn(),
}));

const { finalizeRenderFarmSave } = await import("@/lib/render-farm-save");

const videoId = "video" as Video.VideoId;
const output = {
	width: 1920,
	height: 1080,
	fps: 30,
	durationSeconds: 10,
	bytes: 100,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updates = [];
	mocks.video = {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4" },
		metadata: {
			renderFarmSave: {
				version: 1,
				exportId: "export",
				jobId: "job",
				status: "rendering",
				trigger: "recording",
				startedAt: new Date().toISOString(),
				outputKey: "owner/video/.recording/render/export/result.mp4",
				hlsPrefix: "owner/video/.recording/render/export/hls",
			},
		},
	};
});

test("a published render remakes the share video's previews", async () => {
	await expect(finalizeRenderFarmSave(videoId, "job", output)).resolves.toBe(
		"published",
	);

	expect(mocks.updates).toHaveLength(1);
	expect(mocks.refreshPreviews).toHaveBeenCalledWith("video");
});

test("a stale render leaves the previews alone", async () => {
	await expect(
		finalizeRenderFarmSave(videoId, "other-job", output),
	).resolves.toBe("stale");

	expect(mocks.refreshPreviews).not.toHaveBeenCalled();
});
