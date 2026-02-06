import { clamp, isFiniteNumber, normalizeChannel } from "./math";
import type {
	AspectRatioKey,
	BackgroundSourceSpec,
	NormalizedCameraConfig,
	NormalizedRenderConfig,
	NormalizedTimelineConfig,
	NormalizeRenderConfigResult,
	RenderConfigIssue,
	RgbTuple,
} from "./types";
import { ASPECT_RATIO_KEYS } from "./types";

function issue(
	severity: RenderConfigIssue["severity"],
	code: string,
	path: string,
	message: string,
): RenderConfigIssue {
	return { severity, code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRgbTuple(value: unknown): RgbTuple | null {
	if (!Array.isArray(value) || value.length !== 3) return null;
	const channels = value.map((item) =>
		isFiniteNumber(item) ? normalizeChannel(item) : null,
	);
	if (channels.some((c) => c === null)) return null;
	return channels as RgbTuple;
}

function normalizeBackgroundSource(
	value: unknown,
	issues: RenderConfigIssue[],
): BackgroundSourceSpec {
	const fallback: BackgroundSourceSpec = {
		type: "color",
		value: [255, 255, 255],
		alpha: 1,
	};

	if (!isRecord(value)) {
		issues.push(
			issue(
				"warning",
				"BACKGROUND_SOURCE_INVALID",
				"background.source",
				"Background source is missing or invalid; defaulting to white.",
			),
		);
		return fallback;
	}

	const type = value.type;
	if (type === "color") {
		const rgb = normalizeRgbTuple(value.value);
		if (!rgb) {
			issues.push(
				issue(
					"warning",
					"BACKGROUND_COLOR_INVALID",
					"background.source.value",
					"Background color is invalid; defaulting to white.",
				),
			);
			return fallback;
		}

		const alphaRaw = value.alpha;
		const alpha = isFiniteNumber(alphaRaw) ? clamp(alphaRaw, 0, 1) : 1;
		if (alpha !== 1) {
			issues.push(
				issue(
					"error",
					"BACKGROUND_ALPHA_UNSUPPORTED",
					"background.source.alpha",
					"Background alpha is not supported for export.",
				),
			);
		}

		return { type: "color", value: rgb, alpha };
	}

	if (type === "gradient") {
		const from = normalizeRgbTuple(value.from);
		const to = normalizeRgbTuple(value.to);
		if (!from || !to) {
			issues.push(
				issue(
					"warning",
					"BACKGROUND_GRADIENT_INVALID",
					"background.source",
					"Background gradient is invalid; defaulting to white.",
				),
			);
			return fallback;
		}

		const angleRaw = value.angle;
		const angle = isFiniteNumber(angleRaw) ? clamp(angleRaw, 0, 360) : 90;
		if (isFiniteNumber(angleRaw) && angleRaw !== angle) {
			issues.push(
				issue(
					"warning",
					"BACKGROUND_GRADIENT_ANGLE_CLAMPED",
					"background.source.angle",
					"Gradient angle was clamped to 0..360.",
				),
			);
		}

		return { type: "gradient", from, to, angle };
	}

	if (type === "image" || type === "wallpaper") {
		const rawPath = value.path;
		const path =
			typeof rawPath === "string" && rawPath.trim().length > 0
				? rawPath.trim()
				: null;
		return { type, path };
	}

	issues.push(
		issue(
			"warning",
			"BACKGROUND_SOURCE_UNSUPPORTED",
			"background.source.type",
			"Background source type is not supported; defaulting to white.",
		),
	);

	return fallback;
}

function normalizeTimeline(
	value: unknown,
	issues: RenderConfigIssue[],
): NormalizedTimelineConfig | null {
	if (!isRecord(value)) return null;

	const unsupported: Array<[string, unknown]> = [
		["timeline.zoomSegments", value.zoomSegments],
		["timeline.sceneSegments", value.sceneSegments],
		["timeline.maskSegments", value.maskSegments],
		["timeline.textSegments", value.textSegments],
	];

	for (const [path, list] of unsupported) {
		if (Array.isArray(list) && list.length > 0) {
			issues.push(
				issue(
					"error",
					"TIMELINE_FEATURE_UNSUPPORTED",
					path,
					"Timeline features beyond base segments are not supported for export.",
				),
			);
		}
	}

	if (!Array.isArray(value.segments) || value.segments.length === 0)
		return null;

	const segments = value.segments
		.map((segment, index) => {
			if (!isRecord(segment)) {
				issues.push(
					issue(
						"warning",
						"TIMELINE_SEGMENT_INVALID",
						`timeline.segments[${index}]`,
						"Timeline segment is invalid; ignoring.",
					),
				);
				return null;
			}

			const start = segment.start;
			const end = segment.end;
			const timescale = segment.timescale;

			if (
				!isFiniteNumber(start) ||
				!isFiniteNumber(end) ||
				!isFiniteNumber(timescale)
			) {
				issues.push(
					issue(
						"warning",
						"TIMELINE_SEGMENT_INVALID",
						`timeline.segments[${index}]`,
						"Timeline segment is invalid; ignoring.",
					),
				);
				return null;
			}

			if (Math.abs(timescale - 1) > 1e-6) {
				issues.push(
					issue(
						"error",
						"TIMELINE_TIMESCALE_UNSUPPORTED",
						`timeline.segments[${index}].timescale`,
						"Timescale must be 1 for export.",
					),
				);
			}

			return { start, end, timescale };
		})
		.filter(
			(segment): segment is NonNullable<typeof segment> => segment !== null,
		);

	if (segments.length === 0) return null;

	return { segments };
}

export function normalizeConfigForRender(
	input: unknown,
): NormalizeRenderConfigResult {
	const issues: RenderConfigIssue[] = [];

	const record = isRecord(input) ? input : null;
	if (!record) {
		issues.push(
			issue(
				"error",
				"CONFIG_INVALID",
				"config",
				"Config is not a valid object.",
			),
		);
	}

	const aspectRatioRaw = record?.aspectRatio;
	const aspectRatio: AspectRatioKey | null =
		typeof aspectRatioRaw === "string" &&
		ASPECT_RATIO_KEYS.includes(aspectRatioRaw as AspectRatioKey)
			? (aspectRatioRaw as AspectRatioKey)
			: null;

	const background = isRecord(record?.background) ? record?.background : null;

	const unsupportedBackgroundBlur = background?.blur;
	if (
		isFiniteNumber(unsupportedBackgroundBlur) &&
		Math.abs(unsupportedBackgroundBlur) > 1e-6
	) {
		issues.push(
			issue(
				"error",
				"BACKGROUND_BLUR_UNSUPPORTED",
				"background.blur",
				"Background blur is not supported for export.",
			),
		);
	}

	const unsupportedBackgroundInset = background?.inset;
	if (
		isFiniteNumber(unsupportedBackgroundInset) &&
		Math.abs(unsupportedBackgroundInset) > 1e-6
	) {
		issues.push(
			issue(
				"error",
				"BACKGROUND_INSET_UNSUPPORTED",
				"background.inset",
				"Background inset is not supported for export.",
			),
		);
	}

	if (background && background.crop !== undefined && background.crop !== null) {
		issues.push(
			issue(
				"error",
				"BACKGROUND_CROP_UNSUPPORTED",
				"background.crop",
				"Background crop is not supported for export.",
			),
		);
	}

	if (
		background &&
		background.border !== undefined &&
		background.border !== null
	) {
		issues.push(
			issue(
				"error",
				"BACKGROUND_BORDER_UNSUPPORTED",
				"background.border",
				"Background border is not supported for export.",
			),
		);
	}

	const source = normalizeBackgroundSource(background?.source, issues);

	const paddingRaw = background?.padding;
	const padding = isFiniteNumber(paddingRaw) ? clamp(paddingRaw, 0, 40) : 0;
	if (isFiniteNumber(paddingRaw) && paddingRaw !== padding) {
		issues.push(
			issue(
				"warning",
				"BACKGROUND_PADDING_CLAMPED",
				"background.padding",
				"Background padding was clamped to 0..40.",
			),
		);
	}

	const roundingRaw = background?.rounding;
	const rounding = isFiniteNumber(roundingRaw) ? clamp(roundingRaw, 0, 100) : 0;
	if (isFiniteNumber(roundingRaw) && roundingRaw !== rounding) {
		issues.push(
			issue(
				"warning",
				"BACKGROUND_ROUNDING_CLAMPED",
				"background.rounding",
				"Background rounding was clamped to 0..100.",
			),
		);
	}

	const roundingType =
		background?.roundingType === "rounded" ? "rounded" : "squircle";

	const shadowRaw = background?.shadow;
	const shadow = isFiniteNumber(shadowRaw) ? clamp(shadowRaw, 0, 100) : 0;
	if (isFiniteNumber(shadowRaw) && shadowRaw !== shadow) {
		issues.push(
			issue(
				"warning",
				"BACKGROUND_SHADOW_CLAMPED",
				"background.shadow",
				"Background shadow was clamped to 0..100.",
			),
		);
	}

	const advanced =
		background?.advancedShadow && isRecord(background.advancedShadow)
			? background.advancedShadow
			: null;

	const advancedShadow = {
		size: isFiniteNumber(advanced?.size) ? clamp(advanced.size, 0, 100) : 50,
		opacity: isFiniteNumber(advanced?.opacity)
			? clamp(advanced.opacity, 0, 100)
			: 18,
		blur: isFiniteNumber(advanced?.blur) ? clamp(advanced.blur, 0, 100) : 50,
	};

	const timeline = normalizeTimeline(record?.timeline, issues);

	const camera = normalizeCamera(record?.camera);

	const config: NormalizedRenderConfig = {
		aspectRatio,
		background: {
			source,
			padding,
			rounding,
			roundingType,
			shadow,
			advancedShadow,
		},
		timeline,
		camera: camera ?? undefined,
	};

	return { config, issues };
}

function normalizeCamera(value: unknown): NormalizedCameraConfig | null {
	if (!isRecord(value)) return null;

	const hide = typeof value.hide === "boolean" ? value.hide : true;
	const mirror = typeof value.mirror === "boolean" ? value.mirror : false;

	const posRaw = isRecord(value.position) ? value.position : null;
	const xRaw = posRaw?.x;
	const yRaw = posRaw?.y;
	const x =
		xRaw === "left" || xRaw === "center" || xRaw === "right" ? xRaw : "right";
	const y = yRaw === "top" || yRaw === "bottom" ? yRaw : "bottom";

	const size = isFiniteNumber(value.size) ? clamp(value.size, 5, 50) : 30;
	const roundingVal = isFiniteNumber(value.rounding)
		? clamp(value.rounding, 0, 100)
		: 50;
	const roundingType =
		value.roundingType === "rounded" ? "rounded" : "squircle";

	const shadowVal = isFiniteNumber(value.shadow)
		? clamp(value.shadow, 0, 100)
		: 0;

	const advRaw =
		value.advancedShadow && isRecord(value.advancedShadow)
			? value.advancedShadow
			: null;
	const advancedShadow = {
		size: isFiniteNumber(advRaw?.size) ? clamp(advRaw.size, 0, 100) : 50,
		opacity: isFiniteNumber(advRaw?.opacity)
			? clamp(advRaw.opacity, 0, 100)
			: 18,
		blur: isFiniteNumber(advRaw?.blur) ? clamp(advRaw.blur, 0, 100) : 50,
	};

	return {
		hide,
		mirror,
		position: { x, y },
		size,
		rounding: roundingVal,
		roundingType,
		shadow: shadowVal,
		advancedShadow,
	};
}
