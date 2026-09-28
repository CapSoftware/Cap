/**
 * The look a user can save once and have every new recording rendered with:
 * background (padding, rounding, shadow), framing, camera layout and cursor
 * style, but nothing tied to one recording (crops, project-local images,
 * timeline, captions or colour grades).
 */
export type EditorDefaultStyle = {
	version: 1;
	aspectRatio?: unknown;
	background?: Record<string, unknown>;
	camera?: Record<string, unknown>;
	cursor?: Record<string, unknown>;
};

const MAX_STYLE_BYTES = 64 * 1024;
const PORTABLE_BACKGROUND_SOURCES = new Set([
	"wallpaper",
	"color",
	"gradient",
	"animatedGradient",
]);
const RECORDING_BACKGROUND_FIELDS = new Set(["crop", "displayPosition"]);
// Whether a recording shows its camera belongs to that recording.
const RECORDING_CAMERA_FIELDS = new Set(["hide"]);

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableBackground(background: unknown) {
	if (!asRecord(background)) return undefined;
	const style: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(background)) {
		if (RECORDING_BACKGROUND_FIELDS.has(field)) continue;
		if (field === "source") {
			if (
				asRecord(value) &&
				typeof value.type === "string" &&
				PORTABLE_BACKGROUND_SOURCES.has(value.type)
			) {
				style.source = value;
			}
			continue;
		}
		style[field] = value;
	}
	return Object.keys(style).length > 0 ? style : undefined;
}

export function extractDefaultStyle(
	config: unknown,
): EditorDefaultStyle | null {
	if (!asRecord(config)) return null;
	const style: EditorDefaultStyle = { version: 1 };
	if ("aspectRatio" in config) style.aspectRatio = config.aspectRatio;
	const background = portableBackground(config.background);
	if (background) style.background = background;
	if (asRecord(config.camera)) {
		const camera = Object.fromEntries(
			Object.entries(config.camera).filter(
				([field]) => !RECORDING_CAMERA_FIELDS.has(field),
			),
		);
		if (Object.keys(camera).length > 0) style.camera = camera;
	}
	if (asRecord(config.cursor)) style.cursor = config.cursor;
	return new TextEncoder().encode(JSON.stringify(style)).byteLength <=
		MAX_STYLE_BYTES
		? style
		: null;
}

export function parseDefaultStyle(value: unknown): EditorDefaultStyle | null {
	if (!asRecord(value) || value.version !== 1) return null;
	return extractDefaultStyle(value);
}

/** The project configuration with a saved style laid over its look. */
export function applyDefaultStyle(
	config: Record<string, unknown>,
	style: EditorDefaultStyle,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...config };
	if ("aspectRatio" in style) next.aspectRatio = style.aspectRatio;
	if (style.background) {
		const current = asRecord(config.background) ? config.background : {};
		next.background = {
			...current,
			...style.background,
			...Object.fromEntries(
				[...RECORDING_BACKGROUND_FIELDS]
					.filter((field) => field in current)
					.map((field) => [field, current[field]]),
			),
		};
	}
	if (style.camera) {
		next.camera = {
			...(asRecord(config.camera) ? config.camera : {}),
			...style.camera,
		};
	}
	if (style.cursor) {
		next.cursor = {
			...(asRecord(config.cursor) ? config.cursor : {}),
			...style.cursor,
		};
	}
	return next;
}

export type RecorderCameraLayout = {
	version: 1;
	position: { x: "left" | "center" | "right"; y: "top" | "bottom" };
	size: number;
	mirror: boolean;
	shape: "round" | "square" | "full";
};

export const RECORDER_CAMERA_SIZE = { min: 15, max: 50 } as const;

export function parseRecorderCamera(
	value: unknown,
): RecorderCameraLayout | null {
	if (!asRecord(value) || value.version !== 1) return null;
	const position = asRecord(value.position) ? value.position : null;
	const x = position?.x;
	const y = position?.y;
	if (x !== "left" && x !== "center" && x !== "right") return null;
	if (y !== "top" && y !== "bottom") return null;
	if (
		typeof value.size !== "number" ||
		!Number.isFinite(value.size) ||
		value.size < RECORDER_CAMERA_SIZE.min ||
		value.size > RECORDER_CAMERA_SIZE.max
	) {
		return null;
	}
	if (typeof value.mirror !== "boolean") return null;
	const shape = value.shape;
	if (shape !== "round" && shape !== "square" && shape !== "full") return null;
	return {
		version: 1,
		position: { x, y },
		size: value.size,
		mirror: value.mirror,
		shape,
	};
}

/**
 * The saved style with the camera placed where it was in the browser
 * recorder. Shapes map the same way as the desktop camera preview.
 */
export function withRecorderCamera(
	style: EditorDefaultStyle | null,
	layout: RecorderCameraLayout | null,
): EditorDefaultStyle | null {
	if (!layout) return style;
	const base: EditorDefaultStyle = style ?? { version: 1 };
	return {
		...base,
		camera: {
			...(base.camera ?? {}),
			position: layout.position,
			manualPosition: null,
			size: layout.size,
			mirror: layout.mirror,
			shape: layout.shape === "full" ? "source" : "square",
			rounding: layout.shape === "round" ? 100 : 25,
		},
	};
}

// How a recording looks until its owner saves a style of their own: edge to
// edge, with no background around it.
export const FULL_BLEED_STYLE: EditorDefaultStyle = {
	version: 1,
	background: { padding: 0, rounding: 0, shadow: 0 },
};

/** The style a new recording opens and first renders with. */
export function recordingDefaultStyle(
	savedStyle: unknown,
	recorderCamera: unknown,
): EditorDefaultStyle | null {
	return withRecorderCamera(
		parseDefaultStyle(savedStyle) ?? FULL_BLEED_STYLE,
		parseRecorderCamera(recorderCamera),
	);
}
