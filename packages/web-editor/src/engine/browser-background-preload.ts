import { applyDefaultStyle } from "../bundle/default-style";
import {
	BrowserImageDecoder,
	type DecodedBackgroundImage,
} from "./browser-image-decoder";
import type { BrowserEditorSources } from "./browser-sources";
import { resolveEditorAssetUrl } from "./editor-asset-url";

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function imageSourcePath(background: unknown) {
	const source = record(record(background)?.source);
	if (
		!source ||
		(source.type !== "image" && source.type !== "wallpaper") ||
		typeof source.path !== "string"
	) {
		return null;
	}
	return source.path || null;
}

export function backgroundImagePath(config: unknown) {
	return imageSourcePath(record(config)?.background);
}

/// Images that enabled style segments swap in as the background while they
/// are active; the renderer reads them by path like the main background.
export function styleBackgroundImagePaths(config: unknown) {
	const segments = record(record(config)?.timeline)?.styleSegments;
	if (!Array.isArray(segments)) return [];
	const paths = segments.flatMap((value) => {
		const segment = record(value);
		if (segment?.enabled === false) return [];
		const path = imageSourcePath(record(segment?.overrides)?.background);
		return path ? [path] : [];
	});
	return [...new Set(paths)];
}

export function backgroundImageUrl(path: string) {
	const url = resolveEditorAssetUrl(path);
	return url ? new URL(url, window.location.href).href : null;
}

export function initialProjectConfig(
	sources: Pick<BrowserEditorSources, "projectConfig" | "defaultStyle">,
	defaultsJson: string,
): unknown {
	if (sources.projectConfig !== null && sources.projectConfig !== undefined) {
		return sources.projectConfig;
	}
	const defaults = record(JSON.parse(defaultsJson));
	return sources.defaultStyle && defaults
		? applyDefaultStyle(defaults, sources.defaultStyle)
		: JSON.parse(defaultsJson);
}

let decoder: BrowserImageDecoder | null = null;
let inFlight = 0;
const decoded = new Map<string, Promise<DecodedBackgroundImage>>();

/// The background is known as soon as the recording's sources are, well
/// before the canvas exists, so its download and decode run alongside the
/// renderer's startup and the media probes instead of after them. Keyed by
/// URL, so a path that resolves elsewhere by the time the canvas asks is
/// loaded afresh.
export function preloadBackgroundImage(config: unknown) {
	const path = backgroundImagePath(config);
	const url = path ? backgroundImageUrl(path) : null;
	if (!url || decoded.has(url)) return;
	const owner = decoder ?? new BrowserImageDecoder();
	decoder = owner;
	inFlight++;
	const image = owner.decodeUrl(url);
	decoded.set(url, image);
	void image
		.catch(() => undefined)
		.finally(() => {
			inFlight--;
			if (inFlight === 0 && decoder === owner) {
				owner.dispose();
				decoder = null;
			}
		});
}

/// Hands over the decode for the canvas's first background and drops any
/// other, so a config that changed before the canvas existed does not hold
/// on to an unused wallpaper's pixels.
export function takePreloadedBackground(url: string | null) {
	const image = url ? decoded.get(url) : undefined;
	decoded.clear();
	return image ?? null;
}

export function releasePreloadedBackgrounds() {
	decoded.clear();
	decoder?.dispose();
	decoder = null;
}
