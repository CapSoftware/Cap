import type { AspectRatio, SplitLayout } from "~/utils/tauri";

export type RGBColor = [number, number, number];

// Identity split-screen layout: each pane aspect-fills its half, centred, no
// extra zoom. Used to seed a segment switched into split-screen mode and as the
// fallback when a segment has no `splitLayout` override yet.
export const DEFAULT_SPLIT_LAYOUT: SplitLayout = {
	screenZoom: 1,
	screenPosition: { x: 0.5, y: 0.5 },
	cameraZoom: 1,
	cameraPosition: { x: 0.5, y: 0.5 },
};

export const DEFAULT_GRADIENT_FROM = [71, 133, 255] satisfies RGBColor;
export const DEFAULT_GRADIENT_TO = [255, 71, 102] satisfies RGBColor;

export const DEFAULT_BACKGROUND_PADDING = 10;
export const DEFAULT_BACKGROUND_ROUNDING = 7.5;

// Matches `default_scene_transition` in crates/project: seconds a scene
// segment's fade-in / fade-out takes by default.
export const DEFAULT_SCENE_TRANSITION = 0.3;

// Matches `Camera::default_scale_during_zoom` in crates/project: the camera
// shrinks to 70% of its size during a zoom segment. 1.0 keeps it fixed.
export const DEFAULT_CAMERA_SCALE_DURING_ZOOM = 0.7;

export const ASPECT_RATIOS = {
	wide: { name: "Wide", ratio: [16, 9] },
	vertical: { name: "Vertical", ratio: [9, 16] },
	square: { name: "Square", ratio: [1, 1] },
	classic: { name: "Classic", ratio: [4, 3] },
	tall: { name: "Tall", ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;
