import type {
	AspectRatio,
	BackgroundConfiguration,
	BackgroundSource,
	Camera,
	SceneMode,
	SceneSegment,
} from "~/utils/tauri";
import type { EditorProjectConfiguration } from "./context";

type RGB = [number, number, number];

export type TemplateBackground =
	| { type: "wallpaper"; id: string }
	| { type: "color"; value: RGB }
	| { type: "gradient"; from: RGB; to: RGB; angle: number };

export type EditorTemplate = {
	id: string;
	name: string;
	description: string;
	group: "layout" | "look" | "social";
	aspectRatio: AspectRatio | null;
	background: TemplateBackground;
	padding: number;
	rounding: number;
	shadow: number;
	camera: Pick<Camera, "hide" | "position" | "size" | "rounding" | "shape">;
	/** A scene that covers the whole video, e.g. side by side. */
	scene?: SceneMode;
};

const bubble = (
	x: Camera["position"]["x"],
	y: Camera["position"]["y"],
	size = 30,
): EditorTemplate["camera"] => ({
	hide: false,
	position: { x, y },
	size,
	rounding: 100,
	shape: "square",
});

export const EDITOR_TEMPLATES: EditorTemplate[] = [
	{
		id: "classic",
		name: "Classic",
		description: "Soft wallpaper, camera in the corner",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "macOS/tahoe-dusk-min" },
		padding: 10,
		rounding: 12,
		shadow: 60,
		camera: bubble("right", "bottom"),
	},
	{
		id: "side-by-side",
		name: "Side by side",
		description: "Screen and camera as two cards",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "dark/3" },
		padding: 6,
		rounding: 12,
		shadow: 50,
		camera: bubble("right", "bottom"),
		scene: "floating",
	},
	{
		id: "split",
		name: "Split screen",
		description: "Full-bleed halves, edge to edge",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "color", value: [12, 12, 14] },
		padding: 0,
		rounding: 0,
		shadow: 0,
		camera: bubble("right", "bottom"),
		scene: "splitScreen",
	},
	{
		id: "presenter",
		name: "Presenter",
		description: "A big camera beside your screen",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "blue/3" },
		padding: 12,
		rounding: 14,
		shadow: 60,
		camera: bubble("left", "bottom", 46),
	},
	{
		id: "camera-only",
		name: "Just you",
		description: "Camera full frame, no screen",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "color", value: [18, 18, 20] },
		padding: 0,
		rounding: 0,
		shadow: 0,
		camera: bubble("right", "bottom"),
		scene: "cameraOnly",
	},
	{
		id: "screen-only",
		name: "Screen only",
		description: "No camera, framed screen",
		group: "layout",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "macOS/sequoia-light" },
		padding: 9,
		rounding: 10,
		shadow: 55,
		camera: { ...bubble("right", "bottom"), hide: true },
	},
	{
		id: "midnight",
		name: "Midnight",
		description: "Deep blue gradient, camera top right",
		group: "look",
		aspectRatio: "wide",
		background: {
			type: "gradient",
			from: [20, 24, 64],
			to: [74, 36, 120],
			angle: 135,
		},
		padding: 11,
		rounding: 14,
		shadow: 70,
		camera: bubble("right", "top", 26),
	},
	{
		id: "paper",
		name: "Paper",
		description: "Warm off-white, quiet and clean",
		group: "look",
		aspectRatio: "wide",
		background: { type: "color", value: [244, 241, 234] },
		padding: 8,
		rounding: 10,
		shadow: 35,
		camera: { ...bubble("right", "bottom", 28), rounding: 40 },
	},
	{
		id: "sunset",
		name: "Sunset",
		description: "Warm orange light",
		group: "look",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "orange/2" },
		padding: 10,
		rounding: 14,
		shadow: 60,
		camera: bubble("left", "bottom"),
	},
	{
		id: "studio",
		name: "Studio",
		description: "Dark and focused",
		group: "look",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "macOS/tahoe-night-min" },
		padding: 10,
		rounding: 12,
		shadow: 70,
		camera: bubble("right", "bottom"),
	},
	{
		id: "full-bleed",
		name: "Full bleed",
		description: "Your screen, edge to edge",
		group: "look",
		aspectRatio: null,
		background: { type: "color", value: [0, 0, 0] },
		padding: 0,
		rounding: 0,
		shadow: 0,
		camera: bubble("right", "bottom", 24),
	},
	{
		id: "city",
		name: "City lights",
		description: "Photo backdrop, camera bottom left",
		group: "look",
		aspectRatio: "wide",
		background: { type: "wallpaper", id: "cities/nyc" },
		padding: 12,
		rounding: 14,
		shadow: 70,
		camera: bubble("left", "bottom", 26),
	},
	{
		id: "shorts",
		name: "Shorts",
		description: "Vertical, screen over camera",
		group: "social",
		aspectRatio: "vertical",
		background: { type: "wallpaper", id: "purple/2" },
		padding: 5,
		rounding: 10,
		shadow: 50,
		camera: bubble("center", "bottom", 40),
		scene: "floating",
	},
	{
		id: "square",
		name: "Square post",
		description: "1:1 for feeds",
		group: "social",
		aspectRatio: "square",
		background: {
			type: "gradient",
			from: [255, 122, 89],
			to: [255, 196, 102],
			angle: 160,
		},
		padding: 9,
		rounding: 14,
		shadow: 55,
		camera: bubble("right", "bottom", 32),
	},
	{
		id: "story",
		name: "Story",
		description: "Vertical, big camera",
		group: "social",
		aspectRatio: "vertical",
		background: { type: "wallpaper", id: "blue/5" },
		padding: 6,
		rounding: 12,
		shadow: 50,
		camera: bubble("center", "bottom", 60),
	},
];

export async function templateBackgroundSource(
	background: TemplateBackground,
	resolveWallpaper: (id: string) => Promise<string>,
): Promise<BackgroundSource> {
	return templateSource(
		background,
		background.type === "wallpaper"
			? await resolveWallpaper(background.id)
			: null,
	);
}

export function templateSource(
	background: TemplateBackground,
	wallpaperPath: string | null,
): BackgroundSource {
	if (background.type === "wallpaper") {
		return { type: "wallpaper", path: wallpaperPath };
	}
	if (background.type === "color") {
		return { type: "color", value: background.value };
	}
	return {
		type: "gradient",
		from: background.from,
		to: background.to,
		angle: background.angle,
	};
}

/**
 * Applies a template's look to the project, keeping the edit itself. Scenes a
 * template added span the whole video, so those are swapped out; scenes the
 * person placed themselves stay.
 */
export function applyTemplate(
	project: EditorProjectConfiguration,
	template: EditorTemplate,
	source: BackgroundSource,
	duration: number,
) {
	project.aspectRatio = template.aspectRatio;
	project.background.source = source;
	project.background.padding = template.padding;
	project.background.rounding = template.rounding;
	project.background.shadow = template.shadow;
	project.background.displayPosition = null;
	Object.assign(project.camera, template.camera, { manualPosition: null });

	const timeline = project.timeline;
	if (!timeline) return;
	const scenes = withoutFullSpanScenes(timeline.sceneSegments, duration);
	if (template.scene && duration > 0) {
		scenes.push({ start: 0, end: duration, mode: template.scene });
	}
	timeline.sceneSegments = scenes;
}

const spansVideo = (scene: SceneSegment, duration: number) =>
	scene.start <= 0.001 && scene.end >= duration - 0.001;

/** The scenes a person placed, without any a template laid over everything. */
export function withoutFullSpanScenes(
	scenes: SceneSegment[] | undefined,
	duration: number,
) {
	return (scenes ?? []).filter((scene) => !spansVideo(scene, duration));
}

/** The scene a template laid over the whole video, if there is one. */
export function fullSpanScene(
	scenes: SceneSegment[] | undefined,
	duration: number,
): SceneMode | null {
	return scenes?.find((scene) => spansVideo(scene, duration))?.mode ?? null;
}

type Look = {
	aspectRatio: AspectRatio | null;
	background: Pick<
		BackgroundConfiguration,
		"source" | "padding" | "rounding" | "shadow"
	>;
	camera: EditorTemplate["camera"];
};

function sourceKey(source: BackgroundSource) {
	switch (source.type) {
		case "color":
			return [source.type, ...source.value, source.alpha ?? 255];
		case "gradient":
			return [source.type, ...source.from, ...source.to, source.angle ?? 90];
		case "animatedGradient":
			return [source.type, JSON.stringify(source.config)];
		default:
			return [source.type, source.path];
	}
}

/**
 * What a template or preset sets, as one comparable value, so the gallery
 * can tell which one the project still shows.
 */
export function lookKey(look: Look, scene: SceneMode | null) {
	const { background, camera } = look;
	return JSON.stringify([
		look.aspectRatio ?? null,
		sourceKey(background.source),
		background.padding,
		background.rounding,
		background.shadow,
		camera.hide,
		camera.position.x,
		camera.position.y,
		camera.size,
		camera.rounding,
		camera.shape,
		scene,
	]);
}

export function templateLookKey(
	template: EditorTemplate,
	wallpaperPath: string | null,
) {
	return lookKey(
		{
			aspectRatio: template.aspectRatio,
			background: {
				source: templateSource(template.background, wallpaperPath),
				padding: template.padding,
				rounding: template.rounding,
				shadow: template.shadow,
			},
			camera: template.camera,
		},
		template.scene ?? null,
	);
}
