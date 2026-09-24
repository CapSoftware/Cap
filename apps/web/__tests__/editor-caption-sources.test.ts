import type { VideoMetadata } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { expect, test } from "vitest";
import type { EditTranscript } from "../lib/edit-transcript";
import {
	buildEditorCaptionSourcePlan,
	combineEditorCaptionTranscripts,
	isEditorReplacementOutput,
} from "../lib/editor-caption-sources";

function metadata(hasAudio = true): VideoMetadata {
	return {
		editorSources: {
			version: 1,
			display: {
				key: "owner/video/display.webm",
				contentType: "video/webm",
				size: 4000,
				objectIdentity: JSON.stringify("base"),
			},
		},
		webEditorVideos: {
			version: 1,
			items: [
				{
					key: "owner/video/editor-assets/videos/00000000-0000-4000-8000-000000000001.webm",
					path: "content/videos/00000000-0000-4000-8000-000000000001.webm",
					name: "Extra screen",
					contentType: "video/webm",
					size: 3000,
					objectIdentity: JSON.stringify("clip"),
				},
			],
		},
		webEditorClips: {
			version: 1,
			items: [
				{
					displayPath:
						"content/videos/00000000-0000-4000-8000-000000000001.webm",
					duration: 5,
					fps: 30,
					hasAudio,
				},
			],
		},
	};
}

function instance(cameraDuration = 5) {
	return {
		recordings: {
			segments: [
				{ display: { duration: 10 }, camera: null, mic: null },
				{
					display: { duration: 5 },
					camera: { duration: cameraDuration },
					mic: null,
				},
			],
		},
	};
}

function transcript(durationMs: number, text: string): EditTranscript {
	return {
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs,
		languageCode: "en",
		words: [
			{
				id: "word-0",
				text,
				startMs: 1000,
				endMs: 1300,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
		],
	};
}

test("added clip speech shifts onto the same source timeline as desktop captions", () => {
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		metadata(),
		instance(6),
	);
	if (!plan) throw new Error("Caption source plan was not created");
	const combined = combineEditorCaptionTranscripts(plan, [
		transcript(10_000, "Original"),
		transcript(5000, "Added"),
	]);
	expect(combined?.words.map((word) => [word.text, word.startMs])).toEqual([
		["Original", 1000],
		["Added", 11_000],
	]);
	expect(combined?.durationMs).toBe(16_000);
	expect(new Set(combined?.words.map((word) => word.id)).size).toBe(2);
});

test("a silent added clip preserves its gap and never requires a transcript", () => {
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		metadata(false),
		instance(),
	);
	if (!plan) throw new Error("Caption source plan was not created");
	const combined = combineEditorCaptionTranscripts(plan, [
		transcript(10_000, "Original"),
		null,
	]);
	expect(combined?.durationMs).toBe(15_000);
	expect(combined?.words.map((word) => word.text)).toEqual(["Original"]);
});

test("Studio Cap voice tracks keep their source offsets before a later MP4", () => {
	const details = metadata();
	const capId = "9a2aa734-d076-42c0-8a8a-68db1d2d2a1e";
	const capPath = `content/imports/${capId}.capbundle`;
	details.webEditorVideos?.items.push({
		key: `owner/video/editor-assets/recordings/${capId}.capbundle`,
		path: capPath,
		name: "Studio source",
		contentType: CAP_BUNDLE_CONTENT_TYPE,
		size: 8000,
		objectIdentity: JSON.stringify("cap"),
	});
	details.webEditorImports = {
		version: 1,
		items: [
			{ kind: "cap", path: capPath, clipCount: 2 },
			{
				kind: "clip",
				path: "content/videos/00000000-0000-4000-8000-000000000001.webm",
			},
		],
	};
	const native = {
		recordings: {
			segments: [
				{ display: { duration: 10 }, camera: null, mic: null },
				{
					display: { duration: 5 },
					camera: { duration: 6 },
					mic: { duration: 5.5 },
				},
				{
					display: { duration: 4 },
					camera: null,
					mic: null,
					system_audio: { duration: 4.2 },
				},
				{ display: { duration: 5 }, camera: null, mic: null },
			],
		},
	};
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		native,
		"worker-a",
	);
	if (!plan) throw new Error("Cap caption source plan was not created");
	expect(plan.sources.map((source) => source.mediaDurationMs)).toEqual([
		10_000, 10_200, 5000,
	]);
	expect(plan.sources[1]?.cap).toEqual({
		clipCount: 2,
		workerId: "worker-a",
		path: capPath,
		name: "Studio source",
		segments: [
			{ mediaDurationMs: 5000, segmentDurationMs: 6000, hasAudio: true },
			{ mediaDurationMs: 4000, segmentDurationMs: 4200, hasAudio: true },
		],
	});
	const combined = combineEditorCaptionTranscripts(plan, [
		transcript(10_000, "Original"),
		transcript(10_200, "Cap"),
		transcript(5000, "MP4"),
	]);
	expect(combined?.words.map((word) => [word.text, word.startMs])).toEqual([
		["Original", 1000],
		["Cap", 11_000],
		["MP4", 21_200],
	]);
	expect(combined?.durationMs).toBe(25_200);
});

test("caption cache identities change when a recorded source changes", () => {
	const first = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		metadata(),
		instance(),
	);
	const changed = metadata();
	const asset = changed.webEditorVideos?.items[0];
	if (!asset) throw new Error("Missing clip asset");
	asset.objectIdentity = JSON.stringify("replacement");
	const second = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		changed,
		instance(),
	);
	expect(first?.combinedKey).not.toBe(second?.combinedKey);
	expect(first?.sources[1]?.transcriptKey).not.toBe(
		second?.sources[1]?.transcriptKey,
	);
});

test("a migrated trim captions the immutable original instead of stale raw metadata", () => {
	const details = metadata();
	const original = {
		key: "owner/video/source/original.mp4",
		size: 4321,
		objectIdentity: JSON.stringify("original"),
	};
	const migrated = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		instance(),
		"",
		"es",
		original,
	);
	const stale = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		instance(),
		"",
		"es",
	);
	if (!migrated || !stale) throw new Error("Missing caption plan");
	expect(migrated.sources[0]).toMatchObject({
		key: original.key,
		expectedSize: original.size,
		expectedIdentity: original.objectIdentity,
	});
	expect(migrated.hash).not.toBe(stale.hash);
	expect(migrated.sources[1]?.key).toBe(stale.sources[1]?.key);
});

test("different AssemblyAI languages have separate caption cache identities", () => {
	const auto = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		metadata(),
		instance(),
	);
	const spanish = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		metadata(),
		instance(),
		"",
		"es",
	);
	expect(auto?.language).toBe("auto");
	expect(spanish?.language).toBe("es");
	expect(auto?.combinedKey).not.toBe(spanish?.combinedKey);
	expect(auto?.sources[0]?.transcriptKey).not.toBe(
		spanish?.sources[0]?.transcriptKey,
	);
});

test("stale native segment layouts are rejected before caption generation", () => {
	expect(
		buildEditorCaptionSourcePlan("owner", "video", metadata(), {
			recordings: { segments: [{ display: { duration: 10 } }] },
		}),
	).toBeNull();
	expect(
		buildEditorCaptionSourcePlan("owner", "video", metadata(), {
			recordings: {
				segments: [{ display: { duration: 10 } }, { display: { duration: 0 } }],
			},
		}),
	).toBeNull();
});

test("a reuploaded output cannot be mistaken for the editor's raw source", () => {
	const outputKey =
		"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000001/result.mp4";
	expect(
		isEditorReplacementOutput({
			id: "video",
			ownerId: "owner",
			source: { type: "webMP4", outputKey },
		}),
	).toBe(true);
	expect(
		isEditorReplacementOutput({
			id: "video",
			ownerId: "owner",
			source: { type: "webMP4", outputKey: "owner/video/result.mp4" },
		}),
	).toBe(false);
});
