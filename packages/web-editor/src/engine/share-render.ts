// Mirrors apps/web/lib/share-render.ts: the render farm and the browser Save
// both render the share link, and must produce the same video.

export const SHARE_RENDER_COMPRESSION = "Social";

export const SHARE_RENDER_RESOLUTION = { x: 1920, y: 1080 };

export const SHARE_RENDER_SOURCE_FPS = "source";

const SHARE_RENDER_FPS_OPTIONS = [15, 30, 60];

function recordedFps(value: number | null | undefined) {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 1 &&
		value <= 120
		? value
		: null;
}

/// The desktop export's choice for a recording: the smallest of 15, 30 and
/// 60 fps within 10% of the fastest recorded track.
export function shareRenderFps(
	displayFps: number | null | undefined,
	cameraFps?: number | null,
) {
	const recorded = Math.max(
		recordedFps(displayFps) ?? 0,
		recordedFps(cameraFps) ?? 0,
	);
	if (recorded === 0) return 30;
	return SHARE_RENDER_FPS_OPTIONS.find((fps) => fps * 10 >= recorded * 9) ?? 60;
}
