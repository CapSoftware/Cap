import { expect, test } from "vitest";
import {
	compactEditorCaptionConfig,
	createEditorCaptionCache,
	restoreEditorCaptionConfig,
} from "../lib/editor-caption-transport";
import {
	decodeWebEditorProject,
	encodeWebEditorProject,
} from "../lib/editor-project-storage";

function longCaptionProject() {
	const segments = Array.from({ length: 3_000 }, (_, index) => ({
		id: `segment-${index}`,
		text: "A useful recording process for everyone",
		start: index * 2.4,
		end: index * 2.4 + 2.2,
		words: Array.from({ length: 6 }, (_, wordIndex) => ({
			text: wordIndex === 0 ? "A" : "recording",
			start: index * 2.4 + wordIndex * 0.4,
			end: index * 2.4 + wordIndex * 0.4 + 0.3,
		})),
	}));
	return {
		captions: {
			sourceTimed: true,
			settings: { enabled: true, color: "#FFFFFF" },
			segments,
		},
		timeline: { segments: [], captionSegments: segments },
		camera: { mirror: false },
	};
}

test("two-hour caption payloads are reused for small camera and style edits", async () => {
	const original = longCaptionProject();
	const cache = await createEditorCaptionCache(original);
	expect(cache).not.toBeNull();
	if (!cache) throw new Error("Caption cache was not created");
	const edited = {
		...original,
		camera: { mirror: true },
		captions: {
			...original.captions,
			settings: { enabled: true, color: "#FF0000" },
		},
	};
	const editedCache = await createEditorCaptionCache(edited);
	expect(editedCache?.ref).toBe(cache.ref);
	const compact = compactEditorCaptionConfig(edited, cache);
	expect(JSON.stringify(compact).length).toBeLessThan(
		JSON.stringify(edited).length / 20,
	);
	expect(restoreEditorCaptionConfig(compact, cache)).toEqual(edited);
	const saved = encodeWebEditorProject(original);
	const restoredProject = decodeWebEditorProject(saved.project);
	const persistedCache = await createEditorCaptionCache(restoredProject);
	expect(persistedCache?.ref).toBe(cache.ref);
	expect(restoreEditorCaptionConfig(compact, persistedCache)).toEqual(edited);
	expect(restoreEditorCaptionConfig(compact, null)).toBeNull();
});

test("caption word edits invalidate reuse and a mismatched reference is rejected", async () => {
	const original = longCaptionProject();
	const cache = await createEditorCaptionCache(original);
	if (!cache) throw new Error("Caption cache was not created");
	const changedSegments = original.captions.segments.map((segment, index) =>
		index === 0
			? { ...segment, words: [{ ...segment.words[0], text: "Changed" }] }
			: segment,
	);
	const changed = {
		...original,
		captions: { ...original.captions, segments: changedSegments },
		timeline: { ...original.timeline, captionSegments: changedSegments },
	};
	expect((await createEditorCaptionCache(changed))?.ref).not.toBe(cache.ref);
	const compact = compactEditorCaptionConfig(original, cache);
	expect(
		restoreEditorCaptionConfig(
			{ ...compact, webCaptionRef: "0".repeat(64) },
			cache,
		),
	).toBeNull();
	expect(
		restoreEditorCaptionConfig(
			{
				...compact,
				captions: { ...original.captions },
			},
			cache,
		),
	).toBeNull();
});
