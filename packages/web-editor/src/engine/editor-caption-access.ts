function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasEditorCaptionContent(config: unknown) {
	if (!isRecord(config)) return false;
	if ("webCaptionRef" in config) return true;
	const captions = config.captions;
	const timeline = config.timeline;
	if (isRecord(captions)) {
		if (Array.isArray(captions.segments) && captions.segments.length > 0)
			return true;
		const settings = captions.settings;
		if (
			isRecord(settings) &&
			(settings.enabled === true || settings.exportWithSubtitles === true)
		)
			return true;
	}
	return (
		isRecord(timeline) &&
		Array.isArray(timeline.captionSegments) &&
		timeline.captionSegments.length > 0
	);
}

export function stripEditorCaptionContent(config: Record<string, unknown>) {
	const stripped = { ...config };
	delete stripped.webCaptionRef;
	if (isRecord(config.captions)) {
		const captions = config.captions;
		stripped.captions = {
			...captions,
			segments: [],
			...(isRecord(captions.settings)
				? {
						settings: {
							...captions.settings,
							enabled: false,
							exportWithSubtitles: false,
						},
					}
				: {}),
		};
	}
	if (isRecord(config.timeline)) {
		stripped.timeline = {
			...config.timeline,
			captionSegments: [],
		};
	}
	return stripped;
}

export function preserveEditorCaptionContent(
	config: Record<string, unknown>,
	prior: Record<string, unknown>,
) {
	if (!hasEditorCaptionContent(prior)) return config;
	const preserved = { ...config };
	if (isRecord(prior.captions)) {
		preserved.captions = prior.captions;
	}
	if (isRecord(config.timeline) && isRecord(prior.timeline)) {
		preserved.timeline = {
			...config.timeline,
			captionSegments: prior.timeline.captionSegments,
		};
	}
	return preserved;
}

export function savedEditorProjectAfterFreeEdit(
	config: Record<string, unknown>,
	prior: Record<string, unknown>,
) {
	return preserveEditorCaptionContent(stripEditorCaptionContent(config), prior);
}

export function shouldKeepPriorEditorCaptions(
	config: unknown,
	prior: unknown,
	currentlyPro: boolean,
	preserveExisting: boolean,
) {
	return (
		!hasEditorCaptionContent(config) &&
		hasEditorCaptionContent(prior) &&
		(!currentlyPro || preserveExisting)
	);
}
