import type { VideoMetadata } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { describe, expect, it } from "vitest";
import {
	appendWebEditorImport,
	nextEditorRecordingSegmentIndex,
	normalizeWebEditorImportOrder,
} from "../../lib/editor-imports";

const ownerId = "owner";
const videoId = "video";
const clipPath = "content/videos/00000000-0000-4000-8000-000000000000.mp4";
const capPath =
	"content/imports/00000000-0000-4000-8000-000000000001.capbundle";
const clips: NonNullable<VideoMetadata["webEditorClips"]>["items"] = [
	{ displayPath: clipPath, duration: 2, fps: 30, hasAudio: true },
];
const assets: NonNullable<VideoMetadata["webEditorVideos"]>["items"] = [
	{
		path: capPath,
		key: `${ownerId}/${videoId}/editor-assets/recordings/${capPath.slice("content/imports/".length)}`,
		name: "Studio source",
		contentType: CAP_BUNDLE_CONTENT_TYPE,
		size: 1024,
		objectIdentity: JSON.stringify("etag"),
	},
];

describe("ordered web editor source replay", () => {
	it("migrates existing MP4 clips and computes recording indices across Cap imports", () => {
		const legacy = normalizeWebEditorImportOrder(
			null,
			clips,
			assets,
			ownerId,
			videoId,
		);
		expect(legacy?.items).toEqual([{ kind: "clip", path: clipPath }]);
		if (!legacy) throw new Error("Invalid legacy import order");
		const capFirst = normalizeWebEditorImportOrder(
			{
				version: 1,
				items: [
					{ kind: "cap", path: capPath, clipCount: 2 },
					{ kind: "clip", path: clipPath },
				],
			},
			clips,
			assets,
			ownerId,
			videoId,
		);
		expect(capFirst?.items.map((item) => item.kind)).toEqual(["cap", "clip"]);
		if (!capFirst) throw new Error("Invalid Cap import order");
		expect(nextEditorRecordingSegmentIndex(capFirst)).toBe(4);
		expect(
			appendWebEditorImport(legacy, {
				kind: "cap",
				path: capPath,
				clipCount: 2,
			})?.items,
		).toEqual([
			{ kind: "clip", path: clipPath },
			{ kind: "cap", path: capPath, clipCount: 2 },
		]);
	});

	it("rejects missing clips, duplicate or forged Cap sources, and inflated clip counts", () => {
		expect(
			normalizeWebEditorImportOrder(
				{ version: 1, items: [{ kind: "cap", path: capPath, clipCount: 2 }] },
				clips,
				assets,
				ownerId,
				videoId,
			),
		).toBeNull();
		for (const importItems of [
			[
				{ kind: "clip", path: clipPath },
				{ kind: "clip", path: clipPath },
			],
			[
				{ kind: "clip", path: clipPath },
				{ kind: "cap", path: capPath, clipCount: 0 },
			],
			[
				{ kind: "clip", path: clipPath },
				{ kind: "cap", path: capPath, clipCount: 1001 },
			],
			[
				{ kind: "clip", path: clipPath },
				{ kind: "cap", path: "content/imports/forged.capbundle", clipCount: 2 },
			],
		]) {
			expect(
				normalizeWebEditorImportOrder(
					{ version: 1, items: importItems },
					clips,
					assets,
					ownerId,
					videoId,
				),
			).toBeNull();
		}
	});
});
