export type Layout3DEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export type Layout3DSegment = {
	start: number;
	end: number;
	enabled: boolean;
	rotationX: number;
	rotationY: number;
	depthZoom: number;
	easing: Layout3DEasing;
	fadeDuration: number;
};

export const defaultLayout3DSegment = (
	start: number,
	end: number,
): Layout3DSegment => ({
	start,
	end,
	enabled: true,
	rotationX: 0,
	rotationY: 0,
	depthZoom: 1.0,
	easing: "ease-in-out",
	fadeDuration: 0.5,
});

export const LAYOUT_3D_PRESETS = {
	tiltLeft: {
		rotationX: 5,
		rotationY: -15,
		depthZoom: 1.1,
		label: "Tilt Left",
	},
	tiltRight: {
		rotationX: 5,
		rotationY: 15,
		depthZoom: 1.1,
		label: "Tilt Right",
	},
	zoomIn3D: {
		rotationX: 10,
		rotationY: 0,
		depthZoom: 1.3,
		label: "Zoom In 3D",
	},
	showcase: {
		rotationX: 8,
		rotationY: -20,
		depthZoom: 1.2,
		label: "Showcase",
	},
	subtle: {
		rotationX: 3,
		rotationY: -5,
		depthZoom: 1.05,
		label: "Subtle",
	},
} as const;

export type Layout3DPresetKey = keyof typeof LAYOUT_3D_PRESETS;
