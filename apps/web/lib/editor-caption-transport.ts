export type EditorCaptionCache = {
	ref: string;
	sourceSegments: unknown[];
	trackSegments: unknown[];
};

const CAPTION_REF_FIELD = "webCaptionRef";
const MIN_REUSABLE_CAPTION_BYTES = 128 * 1024;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createEditorCaptionCache(
	config: unknown,
): Promise<EditorCaptionCache | null> {
	if (!asRecord(config)) return null;
	const captions = config.captions;
	const timeline = config.timeline;
	if (
		!asRecord(captions) ||
		!Array.isArray(captions.segments) ||
		!asRecord(timeline) ||
		!Array.isArray(timeline.captionSegments)
	) {
		return null;
	}
	const raw = new TextEncoder().encode(
		JSON.stringify({
			sourceSegments: captions.segments,
			trackSegments: timeline.captionSegments,
		}),
	);
	if (raw.byteLength < MIN_REUSABLE_CAPTION_BYTES || !globalThis.crypto?.subtle)
		return null;
	const digest = await globalThis.crypto.subtle.digest("SHA-256", raw);
	const ref = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return {
		ref,
		sourceSegments: captions.segments,
		trackSegments: timeline.captionSegments,
	};
}

export function compactEditorCaptionConfig(
	config: Record<string, unknown>,
	cache: EditorCaptionCache,
) {
	const captions = config.captions;
	const timeline = config.timeline;
	if (!asRecord(captions) || !asRecord(timeline)) return config;
	const compactCaptions = { ...captions };
	const compactTimeline = { ...timeline };
	delete compactCaptions.segments;
	delete compactTimeline.captionSegments;
	return {
		...config,
		captions: compactCaptions,
		timeline: compactTimeline,
		[CAPTION_REF_FIELD]: cache.ref,
	};
}

export function restoreEditorCaptionConfig(
	config: Record<string, unknown>,
	cache: EditorCaptionCache | null,
): Record<string, unknown> | null {
	if (!(CAPTION_REF_FIELD in config)) return config;
	const ref = config[CAPTION_REF_FIELD];
	const captions = config.captions;
	const timeline = config.timeline;
	if (
		!cache ||
		ref !== cache.ref ||
		!asRecord(captions) ||
		!asRecord(timeline) ||
		"segments" in captions ||
		"captionSegments" in timeline
	) {
		return null;
	}
	const restored = { ...config };
	delete restored[CAPTION_REF_FIELD];
	return {
		...restored,
		captions: { ...captions, segments: cache.sourceSegments },
		timeline: { ...timeline, captionSegments: cache.trackSegments },
	};
}
