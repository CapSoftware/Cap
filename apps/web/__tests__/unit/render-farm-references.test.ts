import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	getOutputPreviewAssetKeys,
	getReplacementOutputKey,
} from "@/lib/published-output";
import {
	parseRenderFarmReference,
	renderFarmKeys,
	renderFarmReference,
} from "@/lib/render-farm";
import {
	awaitingPendingRenderJob,
	BROWSER_SAVE_STALE_MS,
	browserSaveStatus,
	latestSaveIsBrowser,
} from "@/lib/render-farm-status";

describe("render farm references", () => {
	it("keeps saves on the bare video id and tags recording renders", () => {
		expect(renderFarmReference("save", "abc123")).toBe("abc123");
		expect(renderFarmReference("recording", "abc123")).toBe("recording:abc123");
		expect(parseRenderFarmReference("abc123")).toEqual({
			kind: "save",
			videoId: "abc123",
		});
		expect(parseRenderFarmReference("recording:abc123")).toEqual({
			kind: "recording",
			videoId: "abc123",
		});
	});

	it("rejects unknown kinds and malformed ids", () => {
		expect(parseRenderFarmReference("export:abc123")).toBeNull();
		expect(parseRenderFarmReference("thumbnail:abc123")).toBeNull();
		expect(parseRenderFarmReference("recording:")).toBeNull();
		expect(parseRenderFarmReference("recording:../other")).toBeNull();
		expect(parseRenderFarmReference("")).toBeNull();
	});

	it("publishes renders where the share page resolves their preview assets", () => {
		const id = "0f4f9a0e-7c1b-4f37-9f3c-6f2f3b1d2c4a";
		const keys = renderFarmKeys("owner", "video", id);
		expect(keys.outputKey).toBe(
			`owner/video/.recording/outputs/render-${id}/result.mp4`,
		);
		expect(keys.recording).toBe(`owner/video/.recording/render/${id}/project`);
		expect(
			getReplacementOutputKey({
				id: "video",
				ownerId: "owner",
				source: { type: "webMP4", outputKey: keys.outputKey },
			}),
		).toBe(keys.outputKey);
		expect(getOutputPreviewAssetKeys(keys.outputKey).previewKey).toBe(
			`owner/video/.recording/outputs/render-${id}/result/preview.gif`,
		);
	});

	it("waits for a recording render's job only for a while", () => {
		const startedAt = "2026-09-26T00:00:00.000Z";
		expect(
			awaitingPendingRenderJob({ startedAt }, Date.parse(startedAt) + 60_000),
		).toBe(true);
		expect(
			awaitingPendingRenderJob(
				{ startedAt },
				Date.parse(startedAt) + 31 * 60_000,
			),
		).toBe(false);
	});
});

describe("browser saves", () => {
	const save: NonNullable<VideoMetadata["webEditorBrowserSave"]> = {
		version: 1,
		saveId: "11111111-1111-4111-8111-111111111111",
		status: "rendering",
		projectSavedAt: "2026-11-20T00:00:00.000Z",
		progress: 0.4,
		startedAt: "2026-11-20T00:00:00.000Z",
		updatedAt: "2026-11-20T00:01:00.000Z",
	};
	const updated = Date.parse(save.updatedAt);

	it("shows a running save's progress and its end", () => {
		expect(browserSaveStatus(save, updated + 1000)).toMatchObject({
			state: "rendering",
			exportId: save.saveId,
			progress: 0.4,
			playable: false,
			hlsUrl: null,
		});
		expect(
			browserSaveStatus({ ...save, status: "published" }, updated),
		).toMatchObject({ state: "ready", progress: 1 });
		expect(
			browserSaveStatus(
				{ ...save, status: "error", error: "Upload failed" },
				0,
			),
		).toMatchObject({ state: "error", error: "Upload failed" });
	});

	it("marks a running save as one a tab renders, so a reopened editor can take it over", () => {
		expect(browserSaveStatus(save, updated + 1000).inBrowser).toBe(true);
		expect(
			browserSaveStatus({ ...save, status: "published" }, updated).inBrowser,
		).toBeUndefined();
		expect(
			browserSaveStatus(save, updated + BROWSER_SAVE_STALE_MS + 1).inBrowser,
		).toBeUndefined();
	});

	it("treats a save whose tab stopped reporting as failed", () => {
		expect(
			browserSaveStatus(save, updated + BROWSER_SAVE_STALE_MS + 1).state,
		).toBe("error");
	});

	it("follows whichever save started last", () => {
		const farm: NonNullable<VideoMetadata["renderFarmSave"]> = {
			version: 1,
			exportId: "e1",
			jobId: "j1",
			status: "published",
			startedAt: "2026-11-19T00:00:00.000Z",
			outputKey: "k",
			hlsPrefix: "h",
		};
		expect(latestSaveIsBrowser({ webEditorBrowserSave: save })).toBe(true);
		expect(
			latestSaveIsBrowser({ webEditorBrowserSave: save, renderFarmSave: farm }),
		).toBe(true);
		expect(
			latestSaveIsBrowser({
				webEditorBrowserSave: save,
				renderFarmSave: { ...farm, startedAt: "2026-11-21T00:00:00.000Z" },
			}),
		).toBe(false);
		expect(latestSaveIsBrowser({ renderFarmSave: farm })).toBe(false);
	});
});
