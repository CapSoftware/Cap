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
