import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";

const mocks = vi.hoisted(() => ({
	video: null as null | {
		id: string;
		ownerId: string;
		source: Record<string, string>;
	},
	objects: new Map<string, { ContentLength: number }>(),
	updates: [] as unknown[],
	start: vi.fn(),
	fetchPreviewAssets: vi.fn(),
	mediaServerConfigured: vi.fn(() => true),
}));

const effect = <T>(value: T) => ({
	pipe: (run: (value: T) => unknown) => run(value),
});

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
						set: (values: { source: Record<string, string> }) => ({
							where: async () => {
								mocks.updates.push(values);
								if (mocks.video) mocks.video.source = values.source;
							},
						}),
					}),
				}),
		}),
	};
});
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId", source: "source" },
}));
vi.mock("drizzle-orm", () => ({ eq: (...args: unknown[]) => args }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			effect([
				{
					getInternalSignedObjectUrl: (key: string) =>
						effect(`https://storage.test/get/${key}`),
					getInternalPresignedPutUrl: (key: string) =>
						effect(`https://storage.test/put/${key}`),
					headObject: async (key: string) => {
						const head = mocks.objects.get(key);
						if (!head) throw new Error("Object missing");
						return head;
					},
				},
			]),
	},
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: async (value: unknown) =>
		value && typeof value === "object" && "pipe" in value
			? (value as ReturnType<typeof effect>).pipe((inner) => inner)
			: value,
}));
vi.mock("@/lib/media-client", () => ({
	fetchPreviewAssetsViaMediaServer: mocks.fetchPreviewAssets,
	isMediaServerConfigured: mocks.mediaServerConfigured,
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));

const { enqueuePreviewAssetsRefresh } = await import(
	"@/lib/refresh-preview-assets"
);
const { refreshPreviewAssetsWorkflow } = await import(
	"@/workflows/refresh-preview-assets"
);

const outputKey =
	"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result.mp4";
const thumbnailKey =
	"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result/screenshot.jpg";
const previewKey =
	"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result/preview.gif";
const videoId = "video" as Video.VideoId;

function storeGeneratedAssets() {
	mocks.fetchPreviewAssets.mockImplementation(async () => {
		mocks.objects.set(thumbnailKey, { ContentLength: 10 });
		mocks.objects.set(previewKey, { ContentLength: 20 });
		return new Response(JSON.stringify({ success: true }));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.video = {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4", outputKey },
	};
	mocks.objects.clear();
	mocks.updates = [];
	mocks.mediaServerConfigured.mockReturnValue(true);
});

describe("preview asset refresh queue", () => {
	it("starts a refresh for a render shown with the upload's previews", async () => {
		await enqueuePreviewAssetsRefresh(videoId);

		expect(mocks.start).toHaveBeenCalledWith(refreshPreviewAssetsWorkflow, [
			{ videoId: "video", outputKey },
		]);
	});

	it("skips videos that already have previews of their output", async () => {
		mocks.video = {
			id: "video",
			ownerId: "owner",
			source: { type: "webMP4", outputKey, thumbnailKey, previewKey },
		};
		await enqueuePreviewAssetsRefresh(videoId);

		mocks.video = {
			id: "video",
			ownerId: "owner",
			source: {
				type: "desktopMP4",
				outputKey: "owner/video/.recording/outputs/generation/attempt.mp4",
			},
		};
		await enqueuePreviewAssetsRefresh(videoId);

		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does nothing without a media server and never fails the publish", async () => {
		mocks.mediaServerConfigured.mockReturnValue(false);
		await enqueuePreviewAssetsRefresh(videoId);
		expect(mocks.start).not.toHaveBeenCalled();

		mocks.mediaServerConfigured.mockReturnValue(true);
		mocks.start.mockRejectedValueOnce(new Error("workflow unavailable"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(enqueuePreviewAssetsRefresh(videoId)).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});
});

describe("preview asset refresh workflow", () => {
	it("makes both assets from the published output and points the video at them", async () => {
		storeGeneratedAssets();

		await refreshPreviewAssetsWorkflow({ videoId: "video", outputKey });

		expect(mocks.fetchPreviewAssets).toHaveBeenCalledWith({
			videoUrl: `https://storage.test/get/${outputKey}`,
			thumbnailPresignedUrl: `https://storage.test/put/${thumbnailKey}`,
			previewGifPresignedUrl: `https://storage.test/put/${previewKey}`,
		});
		expect(mocks.video?.source).toEqual({
			type: "webMP4",
			outputKey,
			thumbnailKey,
			previewKey,
		});
	});

	it("skips an output that was replaced before its previews were made", async () => {
		mocks.video = {
			id: "video",
			ownerId: "owner",
			source: {
				type: "webMP4",
				outputKey:
					"owner/video/.recording/outputs/reupload-22222222-2222-4222-8222-222222222222/result.mp4",
			},
		};

		await refreshPreviewAssetsWorkflow({ videoId: "video", outputKey });

		expect(mocks.fetchPreviewAssets).not.toHaveBeenCalled();
		expect(mocks.updates).toEqual([]);
	});

	it("does not attach previews to an output replaced while they were made", async () => {
		const next =
			"owner/video/.recording/outputs/reupload-22222222-2222-4222-8222-222222222222/result.mp4";
		mocks.fetchPreviewAssets.mockImplementation(async () => {
			mocks.objects.set(thumbnailKey, { ContentLength: 10 });
			mocks.objects.set(previewKey, { ContentLength: 20 });
			if (mocks.video) mocks.video.source = { type: "webMP4", outputKey: next };
			return new Response("{}");
		});

		await refreshPreviewAssetsWorkflow({ videoId: "video", outputKey });

		expect(mocks.updates).toEqual([]);
		expect(mocks.video?.source).toEqual({ type: "webMP4", outputKey: next });
	});

	it("retries only a busy media server", async () => {
		mocks.fetchPreviewAssets.mockResolvedValueOnce(
			new Response("busy", { status: 503 }),
		);
		await expect(
			refreshPreviewAssetsWorkflow({ videoId: "video", outputKey }),
		).rejects.toBeInstanceOf(RetryableError);

		mocks.fetchPreviewAssets.mockResolvedValueOnce(
			new Response("missing", { status: 404 }),
		);
		await expect(
			refreshPreviewAssetsWorkflow({ videoId: "video", outputKey }),
		).rejects.toBeInstanceOf(FatalError);

		mocks.fetchPreviewAssets.mockResolvedValueOnce(
			new Response("failed", { status: 500 }),
		);
		const failure = refreshPreviewAssetsWorkflow({
			videoId: "video",
			outputKey,
		});
		await expect(failure).rejects.toThrow("Preview assets failed (500)");
		await expect(failure).rejects.toBeInstanceOf(FatalError);
		expect(mocks.updates).toEqual([]);
	});

	it("does not point the video at assets that were never stored", async () => {
		mocks.fetchPreviewAssets.mockResolvedValue(new Response("{}"));

		await expect(
			refreshPreviewAssetsWorkflow({ videoId: "video", outputKey }),
		).rejects.toThrow("Preview assets were not stored");
		expect(mocks.updates).toEqual([]);
	});
});
