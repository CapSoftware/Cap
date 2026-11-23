import { $PROXY } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { expect, test } from "vitest";
import { EditorCaptionCacheMemo } from "./caption-cache-memo";

function longCaptionSegments(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `segment-${index}`,
		text: "A useful recording process",
		start: index * 2.4,
		end: index * 2.4 + 2.2,
		words: Array.from({ length: 6 }, (_, wordIndex) => ({
			text: "recording",
			start: index * 2.4 + wordIndex * 0.4,
			end: index * 2.4 + wordIndex * 0.4 + 0.3,
		})),
	}));
}

test("browser Solid caption cache reuses camera and style edits but invalidates caption words", async () => {
	const segments = longCaptionSegments(800);
	const [project, setProject] = createStore({
		captions: { segments },
		timeline: {
			captionSegments: segments.map((segment) => ({
				...segment,
				words: segment.words.map((word) => ({ ...word })),
			})),
			styleSegments: [{ opacity: 1 }],
		},
		camera: { mirror: false },
	});
	if (!($PROXY in project.captions.segments)) return;
	const cache = new EditorCaptionCacheMemo();
	try {
		const first = cache.get(project);
		const firstValue = await first;
		if (!firstValue) throw new Error("Long caption cache was unavailable");
		setProject("camera", "mirror", true);
		setProject("timeline", "styleSegments", 0, "opacity", 0.5);
		expect(cache.get(project)).toBe(first);
		setProject("captions", "segments", 0, "words", 0, "text", "changed");
		const sourceEdit = cache.get(project);
		expect(sourceEdit).not.toBe(first);
		const sourceValue = await sourceEdit;
		expect(sourceValue?.ref).not.toBe(firstValue.ref);
		setProject("timeline", "captionSegments", 0, "words", 0, "text", "edited");
		const trackEdit = cache.get(project);
		expect(trackEdit).not.toBe(sourceEdit);
		const trackValue = await trackEdit;
		expect(trackValue?.ref).not.toBe(sourceValue?.ref);
		const template = segments[0];
		if (!template) throw new Error("Caption fixture was empty");
		setProject(
			produce((draft) => {
				draft.captions.segments.push({ ...template, id: "added-caption" });
			}),
		);
		const addedCaption = cache.get(project);
		expect(addedCaption).not.toBe(trackEdit);
		expect((await addedCaption)?.ref).not.toBe(trackValue?.ref);
		cache.dispose();
		expect(cache.get(project)).not.toBe(addedCaption);
	} finally {
		cache.dispose();
	}
});

test("mutable non-Solid caption arrays are rehashed after word edits", async () => {
	const segments = longCaptionSegments(800);
	const project = {
		captions: { segments },
		timeline: { captionSegments: segments },
	};
	const cache = new EditorCaptionCacheMemo();
	try {
		const first = cache.get(project);
		const firstValue = await first;
		if (!firstValue) throw new Error("Long caption cache was unavailable");
		segments[0].words[0].text = "changed";
		const second = cache.get(project);
		expect(second).not.toBe(first);
		expect((await second)?.ref).not.toBe(firstValue.ref);
	} finally {
		cache.dispose();
	}
});
