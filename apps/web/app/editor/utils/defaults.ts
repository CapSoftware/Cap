import type { ProjectConfiguration } from "../types/project-config";

export const DEFAULT_PROJECT_CONFIG: ProjectConfiguration = {
	aspectRatio: null,
	background: {
		source: { type: "color", value: [255, 255, 255] },
		blur: 0,
		padding: 0,
		rounding: 0,
		roundingType: "squircle",
		inset: 0,
		crop: null,
		shadow: 73.6,
		advancedShadow: { size: 14.4, opacity: 68.1, blur: 3.8 },
		border: null,
	},
	camera: {
		hide: true,
		mirror: false,
		position: { x: "right", y: "bottom" },
		size: 30,
		zoomSize: 60,
		rounding: 100,
		roundingType: "squircle",
		shadow: 62.5,
		advancedShadow: { size: 33.9, opacity: 44.2, blur: 10.5 },
		shape: "square",
	},
	audio: {
		mute: false,
		improve: false,
		volumeDb: 0,
	},
	cursor: {
		hide: false,
		hideWhenIdle: false,
		hideWhenIdleDelay: 2,
		size: 100,
		type: "auto",
		animationStyle: "mellow",
		tension: 470,
		mass: 3,
		friction: 70,
		raw: false,
		motionBlur: 0.5,
		useSvg: true,
	},
	timeline: null,
	captions: null,
};

export function createDefaultConfig(
	videoDuration: number,
): ProjectConfiguration {
	return {
		...DEFAULT_PROJECT_CONFIG,
		timeline: {
			segments: [{ start: 0, end: videoDuration, timescale: 1 }],
			zoomSegments: [],
		},
	};
}
