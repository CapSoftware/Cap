import { expect, test } from "vitest";
import {
	hasEditorCaptionContent,
	preserveEditorCaptionContent,
	stripEditorCaptionContent,
} from "../lib/editor-caption-access";

test("a Free editor opens an older Pro project without caption layers or export settings", () => {
	const config = {
		camera: { mirror: true },
		captions: {
			segments: [{ id: "word", start: 0, end: 1, text: "Hello" }],
			settings: { enabled: true, exportWithSubtitles: true, font: "Geist" },
		},
		timeline: {
			segments: [{ start: 0, end: 10 }],
			captionSegments: [{ id: "word", start: 0, end: 1 }],
		},
	};
	const free = stripEditorCaptionContent(config);
	expect(hasEditorCaptionContent(config)).toBe(true);
	expect(hasEditorCaptionContent(free)).toBe(false);
	expect(free).toMatchObject({
		camera: { mirror: true },
		captions: {
			segments: [],
			settings: {
				enabled: false,
				exportWithSubtitles: false,
				font: "Geist",
			},
		},
		timeline: {
			segments: [{ start: 0, end: 10 }],
			captionSegments: [],
		},
	});
	expect(config.captions.segments).toHaveLength(1);
});

test("a compacted caption reference cannot bypass a Free entitlement", () => {
	expect(hasEditorCaptionContent({ webCaptionRef: "sha", captions: {} })).toBe(
		true,
	);
	expect(
		hasEditorCaptionContent({
			captions: { segments: [], settings: { enabled: false } },
			timeline: { captionSegments: [] },
		}),
	).toBe(false);
});

test("Free edits keep hidden source captions and overrides for a later Pro reopen", () => {
	const prior = {
		camera: { mirror: false },
		captions: {
			segments: [{ id: "source-1", text: "Paid" }],
			settings: { enabled: true, font: "Geist" },
		},
		timeline: {
			segments: [{ recordingClip: 0, start: 0, end: 10 }],
			captionSegments: [{ id: "source-1", positionOverride: "top-center" }],
		},
	};
	const edited = {
		...stripEditorCaptionContent(prior),
		camera: { mirror: true },
		timeline: {
			segments: [{ recordingClip: 0, start: 2, end: 8 }],
			captionSegments: [],
		},
	};
	const stored = preserveEditorCaptionContent(edited, prior);
	expect(hasEditorCaptionContent(edited)).toBe(false);
	expect(stored).toMatchObject({
		camera: { mirror: true },
		captions: prior.captions,
		timeline: {
			segments: [{ recordingClip: 0, start: 2, end: 8 }],
			captionSegments: prior.timeline.captionSegments,
		},
	});
	expect(prior.camera.mirror).toBe(false);
});
