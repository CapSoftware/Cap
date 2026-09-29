import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/workflow-runtime", () => ({ runWorkflowPromise: vi.fn() }));

const {
	getOutputPreviewAssetKeys,
	getReplacementAwaitingPreviewAssets,
	getReplacementOutputKey,
} = await import("@/lib/published-preview-assets");
const { awaitsReplacementPreviewGif } = await import("@/lib/published-output");

const render =
	"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result.mp4";
const reupload =
	"owner/video/.recording/outputs/reupload-22222222-2222-4222-8222-222222222222/result.mp4";
const video = (source: Record<string, string>) => ({
	id: "video",
	ownerId: "owner",
	source: { type: "webMP4", ...source },
});

describe("published output preview assets", () => {
	it("keeps each output's previews beside it", () => {
		expect(getOutputPreviewAssetKeys(render)).toEqual({
			thumbnailKey:
				"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result/screenshot.jpg",
			previewKey:
				"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result/preview.gif",
		});
	});

	it.each([render, reupload])("recognizes the replacement %s", (outputKey) => {
		expect(getReplacementOutputKey(video({ outputKey }))).toBe(outputKey);
		expect(
			getReplacementOutputKey(video({ type: "desktopMP4", outputKey })),
		).toBe(outputKey);
	});

	it.each([
		undefined,
		"owner/video/result.mp4",
		"owner/video/.recording/outputs/generation/attempt.mp4",
		"owner/video/.recording/sources/generation/snapshot/mp4/0.mp4",
		"owner/video/.recording/outputs/edit-token/result.mp4",
		"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/export.mp4",
		"owner/other/.recording/render/11111111-1111-4111-8111-111111111111/result.mp4",
	])("leaves outputs made with their own previews alone: %s", (outputKey) => {
		expect(
			getReplacementOutputKey(video(outputKey ? { outputKey } : {})),
		).toBeNull();
	});

	it("ignores sources that are not single recordings", () => {
		expect(
			getReplacementOutputKey(
				video({ type: "desktopSegments", outputKey: render }),
			),
		).toBeNull();
	});

	it("awaits previews until both belong to the replacement", () => {
		const keys = getOutputPreviewAssetKeys(render);
		expect(
			getReplacementAwaitingPreviewAssets(video({ outputKey: render })),
		).toBe(render);
		expect(
			getReplacementAwaitingPreviewAssets(
				video({ outputKey: render, thumbnailKey: keys.thumbnailKey }),
			),
		).toBe(render);
		expect(
			getReplacementAwaitingPreviewAssets(
				video({ outputKey: render, ...keys }),
			),
		).toBeNull();
	});

	it("knows a replacement has no preview GIF until its own is made", () => {
		expect(awaitsReplacementPreviewGif(video({ outputKey: render }))).toBe(
			true,
		);
		expect(awaitsReplacementPreviewGif(video({ outputKey: reupload }))).toBe(
			true,
		);
		expect(
			awaitsReplacementPreviewGif(
				video({
					outputKey: render,
					previewKey:
						"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result/preview.gif",
				}),
			),
		).toBe(false);
		expect(awaitsReplacementPreviewGif(video({}))).toBe(false);
		expect(
			awaitsReplacementPreviewGif(
				video({ outputKey: "owner/video/.recording/outputs/gen/attempt.mp4" }),
			),
		).toBe(false);
	});
});
