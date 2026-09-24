import type { VideoMetadata } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { validEditorVideoAsset } from "./editor-video-upload";

export const MAX_WEB_EDITOR_IMPORTS = 100;
export const MAX_WEB_EDITOR_RECORDING_SEGMENTS = 1000;

type SavedClip = NonNullable<VideoMetadata["webEditorClips"]>["items"][number];
type SavedAsset = NonNullable<
	VideoMetadata["webEditorVideos"]
>["items"][number];
export type EditorImport = NonNullable<
	VideoMetadata["webEditorImports"]
>["items"][number];
export type EditorImportOrder = NonNullable<VideoMetadata["webEditorImports"]>;

const CAP_BUNDLE_PATH =
	/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validWebEditorCapImportAsset(
	asset: SavedAsset,
	ownerId: string,
	videoId: string,
) {
	return (
		CAP_BUNDLE_PATH.test(asset.path) &&
		asset.contentType === CAP_BUNDLE_CONTENT_TYPE &&
		validEditorVideoAsset(asset, ownerId, videoId)
	);
}

export function normalizeWebEditorImportOrder(
	raw: unknown,
	clips: readonly SavedClip[],
	assets: readonly SavedAsset[],
	ownerId: string,
	videoId: string,
): EditorImportOrder | null {
	if (raw == null) {
		return {
			version: 1,
			items: clips.map((clip) => ({ kind: "clip", path: clip.displayPath })),
		};
	}
	if (
		!asRecord(raw) ||
		raw.version !== 1 ||
		!Array.isArray(raw.items) ||
		raw.items.length > MAX_WEB_EDITOR_IMPORTS
	) {
		return null;
	}
	const clipPaths = new Set(clips.map((clip) => clip.displayPath));
	const seenClips = new Set<string>();
	const seenCaps = new Set<string>();
	const items: EditorImport[] = [];
	let recordingSegments = 0;
	for (const item of raw.items) {
		if (!asRecord(item) || typeof item.path !== "string") return null;
		if (item.kind === "clip") {
			if (
				!clipPaths.has(item.path) ||
				seenClips.has(item.path) ||
				Object.keys(item).some((key) => !["kind", "path"].includes(key))
			) {
				return null;
			}
			seenClips.add(item.path);
			items.push({ kind: "clip", path: item.path });
			recordingSegments++;
		} else if (item.kind === "cap") {
			const asset = assets.find((candidate) => candidate.path === item.path);
			if (
				!asset ||
				!validWebEditorCapImportAsset(asset, ownerId, videoId) ||
				seenCaps.has(item.path) ||
				typeof item.clipCount !== "number" ||
				!Number.isSafeInteger(item.clipCount) ||
				item.clipCount < 1 ||
				item.clipCount > MAX_WEB_EDITOR_RECORDING_SEGMENTS ||
				Object.keys(item).some(
					(key) => !["kind", "path", "clipCount"].includes(key),
				)
			) {
				return null;
			}
			seenCaps.add(item.path);
			items.push({ kind: "cap", path: item.path, clipCount: item.clipCount });
			recordingSegments += item.clipCount;
		} else {
			return null;
		}
		if (recordingSegments > MAX_WEB_EDITOR_RECORDING_SEGMENTS) return null;
	}
	return seenClips.size === clipPaths.size ? { version: 1, items } : null;
}

export function nextEditorRecordingSegmentIndex(order: EditorImportOrder) {
	return (
		1 +
		order.items.reduce(
			(total, item) => total + (item.kind === "clip" ? 1 : item.clipCount),
			0,
		)
	);
}

export function appendWebEditorImport(
	order: EditorImportOrder,
	item: EditorImport,
): EditorImportOrder | null {
	if (
		order.items.length >= MAX_WEB_EDITOR_IMPORTS ||
		order.items.some((saved) => saved.path === item.path) ||
		nextEditorRecordingSegmentIndex(order) +
			(item.kind === "clip" ? 1 : item.clipCount) >
			MAX_WEB_EDITOR_RECORDING_SEGMENTS + 1
	) {
		return null;
	}
	return { version: 1, items: [...order.items, item] };
}
