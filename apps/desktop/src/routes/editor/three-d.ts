import type {
	Camera3DBlurMode,
	Camera3DBlur as RawCamera3DBlur,
	Camera3DKeyframe as RawCamera3DKeyframe,
	Camera3DProperties as RawCamera3DProperties,
	Camera3DSegment as RawCamera3DSegment,
	Camera3DTracks as RawCamera3DTracks,
} from "~/utils/tauri";

export type { Camera3DBlurMode };

/**
 * Local, strict mirrors of the generated schema: every field is required so the
 * editor never has to re-check for absent values while sampling or editing.
 * `normalizeCamera3DSegments` is the one place the loose wire shape is filled in.
 */
export type Camera3DProperties = {
	tiltX: number;
	tiltY: number;
	roll: number;
	rotateX: number;
	rotateY: number;
	fov: number;
	zoom: number;
	panX: number;
	panY: number;
};

export type Camera3DBlur = {
	mode: Camera3DBlurMode;
	strength: number;
	falloff: number;
	focusX: number;
	focusY: number;
	focusSize: number;
	angle: number;
	dirPosition: number;
	bokeh: boolean;
};

export type Camera3DKeyframe = {
	/** Seconds relative to the segment start. */
	time: number;
	value: number;
	/** Bezier P1 for the span leaving this keyframe. */
	outEasing: [number, number] | null;
	/** Bezier P2 for the span entering this keyframe. */
	inEasing: [number, number] | null;
};

export type Camera3DPropertyKey = keyof Camera3DProperties;

export type Camera3DBlurScalarKey =
	| "strength"
	| "falloff"
	| "focusX"
	| "focusY"
	| "focusSize"
	| "angle"
	| "dirPosition";

export type Camera3DTrackKey =
	| Camera3DPropertyKey
	| "blurStrength"
	| "blurFalloff"
	| "blurFocusSize"
	| "blurFocusX"
	| "blurFocusY"
	| "blurAngle"
	| "blurDirPosition";

export type Camera3DTracks = Record<Camera3DTrackKey, Camera3DKeyframe[]>;

export type Camera3DSegment = {
	start: number;
	end: number;
	enabled: boolean;
	properties: Camera3DProperties;
	blur: Camera3DBlur;
	tracks: Camera3DTracks;
	transitionIn: number;
	transitionOut: number;
};

/**
 * Segments cut straight into their pose: shots open already framed, and the
 * renderer defaults to the same 0 (crates/rendering/src/camera3d.rs).
 */
export const DEFAULT_CAMERA3D_TRANSITION = 0;

/**
 * Handles the renderer falls back to when a keyframe carries none: cubic
 * ease-in-out. Mirrors `DEFAULT_OUT_EASING`/`DEFAULT_IN_EASING` in
 * crates/rendering/src/camera3d.rs.
 */
export const DEFAULT_OUT_EASING: [number, number] = [0.65, 0];
export const DEFAULT_IN_EASING: [number, number] = [0.35, 1];

export const CAMERA3D_PROPERTY_KEYS = [
	"tiltX",
	"tiltY",
	"roll",
	"rotateX",
	"rotateY",
	"fov",
	"zoom",
	"panX",
	"panY",
] as const satisfies readonly Camera3DPropertyKey[];

export const CAMERA3D_BLUR_SCALAR_KEYS = [
	"strength",
	"falloff",
	"focusX",
	"focusY",
	"focusSize",
	"angle",
	"dirPosition",
] as const satisfies readonly Camera3DBlurScalarKey[];

export const CAMERA3D_TRACK_KEYS = [
	"tiltX",
	"tiltY",
	"roll",
	"rotateX",
	"rotateY",
	"fov",
	"zoom",
	"panX",
	"panY",
	"blurStrength",
	"blurFalloff",
	"blurFocusSize",
	"blurFocusX",
	"blurFocusY",
	"blurAngle",
	"blurDirPosition",
] as const satisfies readonly Camera3DTrackKey[];

export type Camera3DLimit = { min: number; max: number; step: number };

export const CAMERA3D_LIMITS = {
	tiltX: { min: -70, max: 70, step: 1 },
	tiltY: { min: -60, max: 60, step: 1 },
	roll: { min: -180, max: 180, step: 1 },
	rotateX: { min: -90, max: 90, step: 1 },
	rotateY: { min: -50, max: 50, step: 1 },
	fov: { min: 10, max: 100, step: 1 },
	zoom: { min: 0.5, max: 10, step: 0.05 },
	panX: { min: -3, max: 3, step: 0.01 },
	panY: { min: -3, max: 3, step: 0.01 },
} satisfies Record<Camera3DPropertyKey, Camera3DLimit>;

export const CAMERA3D_BLUR_LIMITS = {
	strength: { min: 0, max: 60, step: 1 },
	falloff: { min: 0, max: 1, step: 0.01 },
	focusX: { min: 0, max: 1, step: 0.01 },
	focusY: { min: 0, max: 1, step: 0.01 },
	focusSize: { min: 0, max: 1, step: 0.01 },
	angle: { min: 0, max: 360, step: 1 },
	dirPosition: { min: 0, max: 1, step: 0.01 },
} satisfies Record<Camera3DBlurScalarKey, Camera3DLimit>;

export const CAMERA3D_BOKEH_MAX_STRENGTH = 20;

/** Bokeh caps strength, and tilt shift narrows both the band and the angle. */
export const camera3dBlurLimit = (
	key: Camera3DBlurScalarKey,
	blur: Pick<Camera3DBlur, "mode" | "bokeh">,
): Camera3DLimit => {
	switch (key) {
		case "strength":
			return {
				min: 0,
				max: blur.bokeh ? CAMERA3D_BOKEH_MAX_STRENGTH : 60,
				step: 1,
			};
		case "focusSize":
			return {
				min: 0,
				max: blur.mode === "tiltShift" ? 0.6 : 1,
				step: 0.01,
			};
		case "angle":
			return { min: 0, max: blur.mode === "tiltShift" ? 180 : 360, step: 1 };
		default:
			return CAMERA3D_BLUR_LIMITS[key];
	}
};

export const CAMERA3D_TRANSITION_LIMITS = { min: 0, max: 2, step: 0.05 };

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export const defaultCamera3DProperties = (): Camera3DProperties => ({
	tiltX: 0,
	tiltY: 0,
	roll: 0,
	rotateX: 0,
	rotateY: 0,
	fov: 45,
	zoom: 2,
	panX: 0,
	panY: 0,
});

export const defaultCamera3DBlur = (): Camera3DBlur => ({
	mode: "none",
	strength: 0,
	falloff: 0,
	focusX: 0.37,
	focusY: 0.5,
	focusSize: 0.5,
	angle: 0,
	dirPosition: 0.5,
	bokeh: false,
});

/**
 * Blur a new segment opens with: a showcase defocus, so the cinematic look is
 * there before anyone opens the Blur section.
 */
export const showcaseCamera3DBlur = (): Camera3DBlur => ({
	mode: "radial",
	strength: 19,
	falloff: 0.62,
	focusX: 0.37,
	focusY: 0.5,
	focusSize: 0.4,
	angle: 0,
	dirPosition: 0.5,
	bokeh: true,
});

export const defaultCamera3DTracks = (): Camera3DTracks => ({
	tiltX: [],
	tiltY: [],
	roll: [],
	rotateX: [],
	rotateY: [],
	fov: [],
	zoom: [],
	panX: [],
	panY: [],
	blurStrength: [],
	blurFalloff: [],
	blurFocusSize: [],
	blurFocusX: [],
	blurFocusY: [],
	blurAngle: [],
	blurDirPosition: [],
});

/** Re-seeded parameters when the blur mode changes. */
export const CAMERA3D_BLUR_MODE_SEEDS: Record<
	Camera3DBlurMode,
	Partial<Record<Camera3DBlurScalarKey, number>>
> = {
	none: {},
	radial: { focusX: 0.37, focusY: 0.5, focusSize: 0.5 },
	directional: { dirPosition: 0.5, angle: 0 },
	tiltShift: { focusSize: 0.1, focusY: 0.5, angle: 45 },
};

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

/**
 * The seven values an angle preset writes. Content-plane rotation
 * (rotateX/rotateY) is deliberately excluded: presets reframe the camera and
 * leave whatever fold the user has dialled in alone.
 */
export const CAMERA3D_ANGLE_PRESET_KEYS = [
	"tiltX",
	"tiltY",
	"roll",
	"fov",
	"zoom",
	"panX",
	"panY",
] as const;

export type Camera3DAnglePresetKey =
	(typeof CAMERA3D_ANGLE_PRESET_KEYS)[number];

export type Camera3DAnglePreset = {
	id: string;
	name: string;
	values: Record<Camera3DAnglePresetKey, number>;
	/// Every card produces a moving shot: the shot opens on the named pose
	/// (`values`) and drifts toward these overrides.
	drift: Partial<Record<Camera3DAnglePresetKey, number>>;
	/// The defocus the card writes alongside its move. A card is a complete
	/// look, so clicking one never leaves the previous shot's blur behind.
	blur: Camera3DBlur;
};

/**
 * Detail's defocus: a tight, hard-edged focus spot over the close-up, taken
 * from the reference project's opening shot.
 */
const detailCamera3DBlur = (): Camera3DBlur => ({
	mode: "radial",
	strength: 20,
	falloff: 0.76,
	focusX: 0.11,
	focusY: 0.5,
	focusSize: 0.18,
	angle: 0,
	dirPosition: 0.5,
	bokeh: true,
});

/**
 * The overhead shot's defocus: a wide, soft band low and left, taken from the
 * reference project's middle shot.
 */
const overheadCamera3DBlur = (): Camera3DBlur => ({
	mode: "radial",
	strength: 18,
	falloff: 0.72,
	focusX: 0.03,
	focusY: 0.36,
	focusSize: 0.55,
	angle: 0,
	dirPosition: 0.5,
	bokeh: true,
});

/// Cards carry the showcase defocus unless they were authored with their own.
const anglePreset = (
	preset: Omit<Camera3DAnglePreset, "blur"> & { blur?: Camera3DBlur },
): Camera3DAnglePreset => ({
	...preset,
	blur: preset.blur ?? showcaseCamera3DBlur(),
});

export const ANGLE_PRESETS: Camera3DAnglePreset[] = [
	anglePreset({
		id: "spotlight",
		name: "Spotlight",
		values: {
			tiltX: 0,
			tiltY: 0,
			roll: 0,
			fov: 45,
			zoom: 1.35,
			panX: 0.39,
			panY: -0.4,
		},
		// Slow push in with a slight rise.
		drift: { zoom: 1.22, panY: -0.34 },
	}),
	anglePreset({
		id: "perspective",
		name: "Perspective",
		values: {
			tiltX: -28,
			tiltY: 26,
			roll: 5,
			fov: 45,
			zoom: 1.59,
			panX: 0.37,
			panY: -0.15,
		},
		// Orbit sweep.
		drift: { tiltY: 18, zoom: 1.53 },
	}),
	anglePreset({
		id: "center",
		name: "Center",
		values: {
			tiltX: 0,
			tiltY: 0,
			roll: 0,
			fov: 45,
			zoom: 2,
			panX: 0,
			panY: 0,
		},
		// Slow pull back.
		drift: { zoom: 2.25 },
	}),
	anglePreset({
		id: "low-angle",
		name: "Low angle",
		values: {
			tiltX: -50,
			tiltY: 1,
			roll: 0,
			fov: 45,
			zoom: 1.5,
			panX: 0,
			panY: 0,
		},
		// Low-angle rise.
		drift: { tiltX: -44, panY: -0.12 },
	}),
	anglePreset({
		id: "close-up",
		name: "Close up",
		values: {
			tiltX: 26,
			tiltY: -22,
			roll: 1,
			fov: 45,
			zoom: 0.8,
			panX: -0.3,
			panY: -0.4,
		},
		// Truck across the close-up.
		drift: { tiltY: -27, panX: -0.36 },
		// The close-up is the one card that focuses tight and far left.
		blur: detailCamera3DBlur(),
	}),
];

export const anglePresetPose = (
	preset: Camera3DAnglePreset,
): Camera3DProperties => ({
	...defaultCamera3DProperties(),
	...preset.values,
});

/// An angle preset as a motion template: opens on the named pose and drifts.
export const anglePresetMotion = (
	preset: Camera3DAnglePreset,
): Camera3DMotionTemplate => ({
	id: `angle-${preset.id}`,
	name: preset.name,
	from: anglePresetPose(preset),
	to: { ...anglePresetPose(preset), ...preset.drift },
	blur: { ...preset.blur },
});

// A slider cannot express anything finer than one step, so half a step is the
// tightest a pose can be "the same as" a preset and still be reachable.
const presetMatchEpsilon = (key: Camera3DAnglePresetKey) =>
	Math.max(CAMERA3D_LIMITS[key].step / 2, 1e-4);

export const matchAnglePreset = (
	pose: Pick<Camera3DProperties, Camera3DAnglePresetKey>,
): string | null =>
	ANGLE_PRESETS.find((preset) =>
		CAMERA3D_ANGLE_PRESET_KEYS.every(
			(key) =>
				Math.abs(pose[key] - preset.values[key]) <= presetMatchEpsilon(key),
		),
	)?.id ?? null;

export type Camera3DMotionTemplate = {
	id: string;
	name: string;
	from: Camera3DProperties;
	to: Camera3DProperties;
	/// The defocus the template writes. Clicking a card is a complete look, so
	/// the blur is part of the template rather than whatever was there before.
	blur: Camera3DBlur;
};

const pose = (overrides: Partial<Camera3DProperties>): Camera3DProperties => ({
	...defaultCamera3DProperties(),
	...overrides,
});

/// Templates carry the showcase defocus unless authored with their own.
const motionTemplate = (
	template: Omit<Camera3DMotionTemplate, "blur"> & { blur?: Camera3DBlur },
): Camera3DMotionTemplate => ({
	...template,
	blur: template.blur ?? showcaseCamera3DBlur(),
});

export const MOTION_TEMPLATES: Camera3DMotionTemplate[] = [
	motionTemplate({
		id: "glide-across",
		name: "Glide across",
		from: pose({
			tiltX: -46.65,
			tiltY: 42.49,
			rotateY: -20,
			rotateX: -1,
			zoom: 1.785,
			fov: 24,
			panX: 0.673,
			panY: -0.133,
		}),
		to: pose({
			tiltX: -46.65,
			tiltY: 42.49,
			rotateY: -20,
			rotateX: -1,
			zoom: 1.785,
			fov: 24,
			panX: 0.054,
			panY: -0.31,
		}),
	}),
	motionTemplate({
		id: "drift-down",
		name: "Drift down",
		from: pose({ zoom: 0.8, fov: 45, panX: 0.536, panY: -0.452 }),
		to: pose({ zoom: 0.8, fov: 45, panX: 0.544, panY: 0.5 }),
	}),
	motionTemplate({
		id: "rising-sweep",
		name: "Rising sweep",
		from: pose({
			tiltX: -57.83,
			tiltY: -8.7,
			rotateY: -16,
			zoom: 1.51,
			fov: 29,
			panX: -0.634,
			panY: -0.082,
		}),
		to: pose({
			tiltX: -46.65,
			tiltY: -7.94,
			rotateY: -16,
			zoom: 1.51,
			fov: 25,
			panX: -0.613,
			panY: -0.268,
		}),
	}),
	motionTemplate({
		id: "pull-back",
		name: "Pull back",
		from: pose({ rotateX: -14, zoom: 0.715, fov: 45 }),
		to: pose({ rotateX: -14, zoom: 2.1, fov: 45 }),
	}),
	motionTemplate({
		id: "top-down",
		name: "Top down",
		from: pose({
			tiltX: 24.8,
			tiltY: 17.04,
			rotateY: 18,
			rotateX: -40,
			zoom: 0.5,
			fov: 60,
			panX: -0.065,
			panY: -0.195,
		}),
		to: pose({
			tiltX: 34.19,
			tiltY: 15.28,
			rotateY: 9,
			rotateX: -40,
			zoom: 0.5,
			fov: 60,
			panX: -0.217,
			panY: -0.476,
		}),
		// Looking down at the plane wants a wider, softer band than the rest.
		blur: overheadCamera3DBlur(),
	}),
	motionTemplate({
		id: "tilt-away",
		name: "Tilt away",
		from: pose({ rotateX: -5, zoom: 0.5, fov: 45 }),
		to: pose({ rotateX: -21, zoom: 0.6, fov: 45 }),
	}),
	motionTemplate({
		id: "unfold",
		name: "Unfold",
		from: pose({ rotateX: -42.96, zoom: 2.05, fov: 31 }),
		to: pose({ rotateX: -12.01, zoom: 2, fov: 31, panY: -0.179 }),
	}),
	motionTemplate({
		id: "slide-by",
		name: "Slide by",
		from: pose({
			tiltX: -30.29,
			tiltY: 60,
			rotateY: -24,
			rotateX: -39,
			zoom: 1.99,
			fov: 13,
			panX: 0.238,
			panY: 0.135,
		}),
		to: pose({
			tiltX: -30.29,
			tiltY: 60,
			rotateY: -24,
			rotateX: -39,
			zoom: 1.99,
			fov: 13,
			panX: -0.204,
			panY: 0.039,
		}),
	}),
];

export type Camera3DFlipAxis = "horizontal" | "vertical";

/**
 * Mirrors the whole composition across the given axis while the content stays
 * readable: negating the yaw/roll/pan family is exactly conjugating the
 * camera by the mirror, so a "Close up" on the right becomes the identical
 * shot on the left. Applies to both poses, every motion track, and the blur
 * focus, so a moving shot keeps its drift.
 */
export const flipCamera3DSegment = (
	segment: Camera3DSegment,
	axis: Camera3DFlipAxis,
) => {
	// Roll negates on both axes: a mirror reverses in-plane rotation.
	const negated: Camera3DPropertyKey[] =
		axis === "horizontal"
			? ["tiltY", "rotateY", "roll", "panX"]
			: ["tiltX", "rotateX", "roll", "panY"];
	for (const key of negated) {
		segment.properties[key] = -segment.properties[key];
		for (const keyframe of segment.tracks[key])
			keyframe.value = -keyframe.value;
	}

	const focusKey = axis === "horizontal" ? "focusX" : "focusY";
	const focusTrack = axis === "horizontal" ? "blurFocusX" : "blurFocusY";
	segment.blur[focusKey] = 1 - segment.blur[focusKey];
	for (const keyframe of segment.tracks[focusTrack])
		keyframe.value = 1 - keyframe.value;

	// Directional/band angles mirror too: (cos, sin) reflected across the
	// axis is 180 - a horizontally, -a vertically.
	const mirrorAngle = (value: number) => {
		const flipped = axis === "horizontal" ? 180 - value : -value;
		return ((flipped % 360) + 360) % 360;
	};
	segment.blur.angle = mirrorAngle(segment.blur.angle);
	for (const keyframe of segment.tracks.blurAngle)
		keyframe.value = mirrorAngle(keyframe.value);
};

/**
 * Replaces the segment's motion with the template's two poses. Linear is the
 * explicit pair the template writes, so the move reads exactly as authored
 * instead of picking up the default cubic ease.
 *
 * The template's defocus goes on with it: a card is one complete look, so what
 * the preview promises is what the segment ends up holding.
 */
export const applyMotionTemplate = (
	segment: Camera3DSegment,
	template: Camera3DMotionTemplate,
) => {
	setMotion(segment, template.from, template.to, LINEAR_MOTION_EASING);
	segment.blur = { ...template.blur };
	// A template owns the whole move, so the segment cuts in and out of it.
	// Segments authored before the 0 default can still carry a ramp.
	segment.transitionIn = 0;
	segment.transitionOut = 0;
};

// -----------------------------------------------------------------------------
// Scenes
// -----------------------------------------------------------------------------

/**
 * One shot of a scene: a move, a look, and the share of the scene's time range
 * it holds. Weights are relative, so a scene reads the same whatever length it
 * is dropped onto.
 */
export type Camera3DSceneShot = {
	/** Fraction of the scene's time range. */
	weight: number;
	/** The card this shot was built from, when it came from one. */
	name?: string;
	from: Camera3DProperties;
	to: Camera3DProperties;
	blur: Camera3DBlur;
};

/** A chained multi-shot sequence: one click, several cuts. */
export type Camera3DScene = {
	id: string;
	name: string;
	shots: Camera3DSceneShot[];
};

const anglePresetById = (id: string) =>
	ANGLE_PRESETS.find((preset) => preset.id === id) ?? ANGLE_PRESETS[0];

const motionTemplateById = (id: string) =>
	MOTION_TEMPLATES.find((template) => template.id === id) ??
	MOTION_TEMPLATES[0];

/// A card's complete look as one shot of a scene.
const templateShot = (
	template: Camera3DMotionTemplate,
	weight: number,
): Camera3DSceneShot => ({
	weight,
	name: template.name,
	from: { ...template.from },
	to: { ...template.to },
	blur: { ...template.blur },
});

export const CAMERA3D_SCENES: Camera3DScene[] = [
	{
		// Transcribed verbatim from the hand-built reference project: a tight
		// close-up truck, a fold-down overhead sweep, then a long push in.
		id: "showcase",
		name: "Showcase",
		shots: [
			{
				weight: 0.27,
				from: pose({
					tiltX: 26,
					tiltY: -22,
					roll: 1,
					fov: 45,
					zoom: 0.8,
					panX: -0.3,
					panY: -0.4,
				}),
				to: pose({
					tiltX: 26,
					tiltY: -27,
					roll: 1,
					fov: 45,
					zoom: 0.8,
					panX: -0.36,
					panY: -0.4,
				}),
				blur: detailCamera3DBlur(),
			},
			{
				weight: 0.25,
				from: pose({
					tiltX: 24.8,
					tiltY: 17.04,
					rotateX: -40,
					rotateY: 18,
					fov: 60,
					zoom: 0.5,
					panX: -0.065,
					panY: -0.195,
				}),
				to: pose({
					tiltX: 34.19,
					tiltY: 15.28,
					rotateX: -40,
					rotateY: 9,
					fov: 60,
					zoom: 0.5,
					panX: -0.217,
					panY: -0.476,
				}),
				blur: overheadCamera3DBlur(),
			},
			{
				weight: 0.48,
				from: pose({ rotateX: -14, fov: 45, zoom: 0.715 }),
				to: pose({ rotateX: -14, fov: 45, zoom: 1.6 }),
				blur: {
					mode: "radial",
					strength: 19,
					falloff: 0.67,
					focusX: 0.37,
					focusY: 0.52,
					focusSize: 0.4,
					angle: 0,
					dirPosition: 0.5,
					bokeh: true,
				},
			},
		],
	},
	{
		// Reveal, orbit, settle: the shape a product walkthrough wants.
		id: "product-tour",
		name: "Product tour",
		shots: [
			templateShot(motionTemplateById("unfold"), 0.3),
			templateShot(anglePresetMotion(anglePresetById("perspective")), 0.3),
			templateShot(anglePresetMotion(anglePresetById("center")), 0.4),
		],
	},
	{
		// Push in, hold on the detail, then release.
		id: "punch-in",
		name: "Punch in",
		shots: [
			templateShot(anglePresetMotion(anglePresetById("spotlight")), 0.3),
			templateShot(anglePresetMotion(anglePresetById("close-up")), 0.3),
			templateShot(motionTemplateById("pull-back"), 0.4),
		],
	},
];

/**
 * The scene's leading `count` shots with their weights renormalized, so a
 * shorter sequence still fills the whole range it is laid onto. Asking for
 * more shots than the scene holds simply returns the scene.
 */
export const sceneWithShotCount = (
	scene: Camera3DScene,
	count: number,
): Camera3DScene => {
	const kept = Math.min(Math.max(Math.floor(count), 1), scene.shots.length);
	if (kept >= scene.shots.length) return scene;

	const shots = scene.shots.slice(0, kept);
	const totalWeight = shots.reduce(
		(sum, shot) => sum + Math.max(shot.weight, 0),
		0,
	);
	return {
		...scene,
		shots: shots.map((shot) => ({
			...shot,
			weight:
				totalWeight > 0
					? Math.max(shot.weight, 0) / totalWeight
					: 1 / shots.length,
		})),
	};
};

/**
 * No generated shot is shorter than this: below a second a cut reads as a
 * glitch rather than an edit.
 */
export const CAMERA3D_MIN_SHOT_DURATION = 1;

/**
 * How far a shot boundary will travel to land on a clip cut, as a fraction of
 * the scene's range. Cutting the camera exactly where the footage cuts is what
 * makes a generated sequence look authored.
 */
export const CAMERA3D_SCENE_SNAP_FRACTION = 0.15;

const nearestValue = (values: number[], target: number) => {
	let nearest: number | null = null;
	let distance = Number.POSITIVE_INFINITY;
	for (const value of values) {
		const candidate = Math.abs(value - target);
		if (candidate >= distance) continue;
		distance = candidate;
		nearest = value;
	}
	return nearest;
};

/**
 * Lays a scene across [start, end] as a chain of segments.
 *
 * Boundaries come from the shot weights, then each interior one looks for a
 * clip cut to sit on. A snap is dropped rather than forced when it would push a
 * shot under the minimum, and a range too short for the whole scene simply gets
 * its leading shots.
 */
export const applySceneToRange = (
	scene: Camera3DScene,
	start: number,
	end: number,
	clipCuts: number[] = [],
): Camera3DSegment[] => {
	const length = end - start;
	if (!(length > 0) || scene.shots.length === 0) return [];

	const shots = scene.shots.slice(
		0,
		Math.max(
			1,
			Math.min(
				scene.shots.length,
				Math.floor(length / CAMERA3D_MIN_SHOT_DURATION),
			),
		),
	);
	const totalWeight = shots.reduce(
		(sum, shot) => sum + Math.max(shot.weight, 0),
		0,
	);
	const share = (shot: Camera3DSceneShot) =>
		totalWeight > 0 ? Math.max(shot.weight, 0) / totalWeight : 1 / shots.length;

	const cuts = clipCuts.filter((cut) => cut > start && cut < end);
	const snapWindow = length * CAMERA3D_SCENE_SNAP_FRACTION;

	const boundaries = [start];
	let cumulative = 0;
	for (let index = 0; index < shots.length - 1; index++) {
		cumulative += share(shots[index]);
		// Every shot still to come needs its own minimum, so this boundary lives
		// in whatever is left once they are reserved.
		const min = boundaries[index] + CAMERA3D_MIN_SHOT_DURATION;
		const max = end - (shots.length - 1 - index) * CAMERA3D_MIN_SHOT_DURATION;
		const weighted = clamp(start + length * cumulative, min, max);
		const cut = nearestValue(cuts, weighted);
		boundaries.push(
			cut !== null &&
				Math.abs(cut - weighted) <= snapWindow &&
				cut >= min &&
				cut <= max
				? cut
				: weighted,
		);
	}
	boundaries.push(end);

	return shots.map((shot, index) => {
		const segment: Camera3DSegment = {
			start: boundaries[index],
			end: boundaries[index + 1],
			enabled: true,
			properties: defaultCamera3DProperties(),
			blur: { ...shot.blur },
			tracks: defaultCamera3DTracks(),
			transitionIn: 0,
			transitionOut: 0,
		};
		setMotion(segment, shot.from, shot.to, LINEAR_MOTION_EASING);
		return segment;
	});
};

/** Pose the "Reset camera" action writes: a canonical long lens. */
export const CAMERA3D_RESET_POSE: Camera3DProperties = {
	tiltX: 0,
	tiltY: 0,
	roll: 0,
	rotateX: 0,
	rotateY: 0,
	fov: 24,
	zoom: 4.5,
	panX: 0,
	panY: 0,
};

// -----------------------------------------------------------------------------
// Motion easings
// -----------------------------------------------------------------------------

/**
 * One named curve for the whole move: the pair of split bezier handles the two
 * keyframes carry. There is no per-keyframe easing to pick any more, because a
 * segment only ever holds one span.
 */
export type Camera3DMotionEasing = {
	id: string;
	label: string;
	/** Bezier P1, written onto the start keyframe. */
	out: [number, number];
	/** Bezier P2, written onto the end keyframe. */
	in: [number, number];
};

export const MOTION_EASINGS: Camera3DMotionEasing[] = [
	// Linear is the default: it is what every template is authored in.
	{ id: "linear", label: "Linear", out: [0, 0], in: [1, 1] },
	{ id: "smooth", label: "Smooth", out: [0.65, 0], in: [0.35, 1] },
	{ id: "easeIn", label: "Ease in", out: [0.32, 0], in: [1, 1] },
	{ id: "easeOut", label: "Ease out", out: [0, 0], in: [0.68, 1] },
];

export const LINEAR_MOTION_EASING = MOTION_EASINGS[0];

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

export const normalizeCamera3DProperties = (
	properties?: RawCamera3DProperties | null,
): Camera3DProperties => {
	const defaults = defaultCamera3DProperties();
	if (!properties) return defaults;
	return {
		tiltX: properties.tiltX ?? defaults.tiltX,
		tiltY: properties.tiltY ?? defaults.tiltY,
		roll: properties.roll ?? defaults.roll,
		rotateX: properties.rotateX ?? defaults.rotateX,
		rotateY: properties.rotateY ?? defaults.rotateY,
		fov: properties.fov ?? defaults.fov,
		zoom: properties.zoom ?? defaults.zoom,
		panX: properties.panX ?? defaults.panX,
		panY: properties.panY ?? defaults.panY,
	};
};

export const normalizeCamera3DBlur = (
	blur?: RawCamera3DBlur | null,
): Camera3DBlur => {
	const defaults = defaultCamera3DBlur();
	if (!blur) return defaults;
	return {
		mode: blur.mode ?? defaults.mode,
		strength: blur.strength ?? defaults.strength,
		falloff: blur.falloff ?? defaults.falloff,
		focusX: blur.focusX ?? defaults.focusX,
		focusY: blur.focusY ?? defaults.focusY,
		focusSize: blur.focusSize ?? defaults.focusSize,
		angle: blur.angle ?? defaults.angle,
		dirPosition: blur.dirPosition ?? defaults.dirPosition,
		bokeh: blur.bokeh ?? defaults.bokeh,
	};
};

const normalizeKeyframes = (
	keyframes?: RawCamera3DKeyframe[] | null,
): Camera3DKeyframe[] =>
	(keyframes ?? [])
		.map((keyframe) => ({
			time: keyframe.time,
			value: keyframe.value,
			outEasing: keyframe.outEasing ?? null,
			inEasing: keyframe.inEasing ?? null,
		}))
		.sort((a, b) => a.time - b.time);

export const normalizeCamera3DTracks = (
	tracks?: RawCamera3DTracks | null,
): Camera3DTracks => {
	const normalized = defaultCamera3DTracks();
	if (!tracks) return normalized;
	for (const key of CAMERA3D_TRACK_KEYS) {
		normalized[key] = normalizeKeyframes(tracks[key]);
	}
	return normalized;
};

/**
 * Motion always spans the whole segment in the start/end model, so after a
 * resize (or when loading a project resized before this invariant existed)
 * every track's keyframe times are rescaled onto the new duration. Repeated
 * application is a fixpoint, so calling it during a live drag is safe.
 */
export const fitCamera3DMotionToSegment = (segment: Camera3DSegment) => {
	const length = Math.max(segment.end - segment.start, 0);
	let span = 0;
	for (const key of CAMERA3D_TRACK_KEYS)
		for (const keyframe of segment.tracks[key])
			span = Math.max(span, keyframe.time);
	if (span < 1e-6 || Math.abs(span - length) < 1e-6) return;
	const scale = length / span;
	for (const key of CAMERA3D_TRACK_KEYS)
		for (const keyframe of segment.tracks[key]) keyframe.time *= scale;
};

export const normalizeCamera3DSegments = (
	segments?: RawCamera3DSegment[] | null,
): Camera3DSegment[] =>
	(segments ?? [])
		.map((segment) => {
			const normalized = {
				start: segment.start,
				end: segment.end,
				enabled: segment.enabled ?? true,
				properties: normalizeCamera3DProperties(segment.properties),
				blur: normalizeCamera3DBlur(segment.blur),
				tracks: normalizeCamera3DTracks(segment.tracks),
				transitionIn: segment.transitionIn ?? DEFAULT_CAMERA3D_TRANSITION,
				transitionOut: segment.transitionOut ?? DEFAULT_CAMERA3D_TRANSITION,
			};
			fitCamera3DMotionToSegment(normalized);
			return normalized;
		})
		.sort((a, b) => a.start - b.start || a.end - b.end);

export const defaultCamera3DSegment = (
	start: number,
	end: number,
): Camera3DSegment => {
	const angled =
		ANGLE_PRESETS.find((preset) => preset.id === "perspective") ??
		ANGLE_PRESETS[0];
	return {
		start,
		end,
		enabled: true,
		// New segments open on a real pose so the 3D look is visible immediately.
		properties: anglePresetPose(angled),
		blur: showcaseCamera3DBlur(),
		tracks: defaultCamera3DTracks(),
		transitionIn: DEFAULT_CAMERA3D_TRANSITION,
		transitionOut: DEFAULT_CAMERA3D_TRANSITION,
	};
};

// -----------------------------------------------------------------------------
// Sampling (mirrors crates/rendering/src/camera3d.rs)
// -----------------------------------------------------------------------------

const bezierComponent = (p1: number, p2: number, t: number) => {
	const inv = 1 - t;
	return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
};

const bezierDerivative = (p1: number, p2: number, t: number) => {
	const a = 1 - 3 * p2 + 3 * p1;
	const b = 3 * p2 - 6 * p1;
	const c = 3 * p1;
	return (3 * a * t + 2 * b) * t + c;
};

/**
 * Cubic-bezier timing with control points P1/P2 (P0 = (0,0), P3 = (1,1)):
 * 8 Newton iterations, then bisection.
 */
export const bezierEase = (
	p1: readonly [number, number],
	p2: readonly [number, number],
	t: number,
) => {
	if (t <= 0) return 0;
	if (t >= 1) return 1;

	const [x1, y1] = p1;
	const [x2, y2] = p2;
	// Linear fast path ([0,0]/[1,1] handles).
	if (x1 === y1 && x2 === y2 && x1 === 0 && x2 === 1) return t;

	let guess = t;
	for (let i = 0; i < 8; i++) {
		const error = bezierComponent(x1, x2, guess) - t;
		if (Math.abs(error) < 1e-5) return bezierComponent(y1, y2, guess);
		const slope = bezierDerivative(x1, x2, guess);
		if (Math.abs(slope) < 1e-6) break;
		guess -= error / slope;
	}

	let lo = 0;
	let hi = 1;
	guess = t;
	for (let i = 0; i < 30; i++) {
		const error = bezierComponent(x1, x2, guess) - t;
		if (Math.abs(error) < 1e-5) break;
		if (error > 0) hi = guess;
		else lo = guess;
		guess = (lo + hi) / 2;
	}
	return bezierComponent(y1, y2, guess);
};

const sortedByTime = (keys: Camera3DKeyframe[]) => {
	for (let i = 1; i < keys.length; i++) {
		if (keys[i].time < keys[i - 1].time)
			return [...keys].sort((a, b) => a.time - b.time);
	}
	return keys;
};

/**
 * Samples one per-property track: base value when empty, hold outside the keyed
 * range, split-handle bezier lerp between neighbours.
 */
export const sampleTrack = (
	base: number,
	keys: Camera3DKeyframe[] | null | undefined,
	time: number,
) => {
	const list = keys ?? [];
	if (list.length === 0) return base;

	const sorted = sortedByTime(list);

	if (time <= sorted[0].time) return sorted[0].value;

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const next = sorted[i];
		if (time > next.time) continue;
		const span = Math.max(next.time - prev.time, 1e-6);
		const progress = clamp((time - prev.time) / span, 0, 1);
		const eased = bezierEase(
			prev.outEasing ?? DEFAULT_OUT_EASING,
			next.inEasing ?? DEFAULT_IN_EASING,
			progress,
		);
		return prev.value + (next.value - prev.value) * eased;
	}

	return sorted[sorted.length - 1].value;
};

export const evaluatePose = (
	segment: Camera3DSegment,
	relativeTime: number,
): Camera3DProperties => {
	const base = segment.properties;
	const tracks = segment.tracks;
	return {
		tiltX: sampleTrack(base.tiltX, tracks.tiltX, relativeTime),
		tiltY: sampleTrack(base.tiltY, tracks.tiltY, relativeTime),
		roll: sampleTrack(base.roll, tracks.roll, relativeTime),
		rotateX: sampleTrack(base.rotateX, tracks.rotateX, relativeTime),
		rotateY: sampleTrack(base.rotateY, tracks.rotateY, relativeTime),
		fov: sampleTrack(base.fov, tracks.fov, relativeTime),
		zoom: sampleTrack(base.zoom, tracks.zoom, relativeTime),
		panX: sampleTrack(base.panX, tracks.panX, relativeTime),
		panY: sampleTrack(base.panY, tracks.panY, relativeTime),
	};
};

export const evaluateBlur = (
	segment: Camera3DSegment,
	relativeTime: number,
): Camera3DBlur => {
	const base = segment.blur;
	const tracks = segment.tracks;
	return {
		mode: base.mode,
		bokeh: base.bokeh,
		strength: sampleTrack(base.strength, tracks.blurStrength, relativeTime),
		falloff: sampleTrack(base.falloff, tracks.blurFalloff, relativeTime),
		focusX: sampleTrack(base.focusX, tracks.blurFocusX, relativeTime),
		focusY: sampleTrack(base.focusY, tracks.blurFocusY, relativeTime),
		focusSize: sampleTrack(base.focusSize, tracks.blurFocusSize, relativeTime),
		angle: sampleTrack(base.angle, tracks.blurAngle, relativeTime),
		dirPosition: sampleTrack(
			base.dirPosition,
			tracks.blurDirPosition,
			relativeTime,
		),
	};
};

// -----------------------------------------------------------------------------
// Start pose / end pose
// -----------------------------------------------------------------------------

/**
 * Below this a move is a hold: nothing a slider can express is finer, so two
 * poses this close are stored as a still shot with no keyframes at all.
 */
export const MOTION_STILL_EPSILON = 1e-4;

/** The pose the segment opens on, whatever form its tracks are stored in. */
export const getStartPose = (segment: Camera3DSegment): Camera3DProperties =>
	evaluatePose(segment, 0);

/** The pose the segment lands on, whatever form its tracks are stored in. */
export const getEndPose = (segment: Camera3DSegment): Camera3DProperties =>
	evaluatePose(segment, Math.max(segment.end - segment.start, 0));

export const camera3DPosesEqual = (
	a: Camera3DProperties,
	b: Camera3DProperties,
) =>
	CAMERA3D_PROPERTY_KEYS.every(
		(key) => Math.abs(a[key] - b[key]) < MOTION_STILL_EPSILON,
	);

/** Whether any camera property is animated. Blur is never keyed. */
export const hasCamera3DMotion = (segment: Camera3DSegment) =>
	CAMERA3D_PROPERTY_KEYS.some((key) => segment.tracks[key].length > 0);

/**
 * The one way the editor authors camera animation: a segment is a start pose
 * and an end pose, and this writes that pair into the per-property tracks the
 * renderer reads. A property that does not move keeps no keyframes at all, so
 * a still shot stores as a plain base pose.
 *
 * Blur is never touched here: it is segment-level and static.
 *
 * An older segment carrying a richer track flattens to this form on its first
 * edit, which is intended: it flattens onto the poses it already opened and
 * closed on.
 */
export const setMotion = (
	segment: Camera3DSegment,
	start: Camera3DProperties,
	end: Camera3DProperties,
	easing: Camera3DMotionEasing = LINEAR_MOTION_EASING,
) => {
	const length = Math.max(segment.end - segment.start, 0);
	for (const key of CAMERA3D_PROPERTY_KEYS) {
		const from = start[key];
		const to = end[key];
		// The base pose always carries the start: it is what shows when the track
		// is empty, and what the renderer holds outside the keyed range.
		segment.properties[key] = from;
		if (Math.abs(from - to) < MOTION_STILL_EPSILON) {
			segment.tracks[key] = [];
			continue;
		}
		segment.tracks[key] = [
			{ time: 0, value: from, outEasing: [...easing.out], inEasing: null },
			{ time: length, value: to, outEasing: null, inEasing: [...easing.in] },
		];
	}
};

const EASING_MATCH_EPSILON = 1e-3;

const handlesMatch = (
	a: readonly [number, number],
	b: readonly [number, number],
) =>
	Math.abs(a[0] - b[0]) <= EASING_MATCH_EPSILON &&
	Math.abs(a[1] - b[1]) <= EASING_MATCH_EPSILON;

/**
 * The curve the segment's move runs on, read back off its first animated camera
 * track. Anything unrecognised (a hand-keyed segment from before this model)
 * reads as Linear, and picking a style rewrites both handles anyway.
 */
export const getMotionEasing = (
	segment: Camera3DSegment,
): Camera3DMotionEasing => {
	for (const key of CAMERA3D_PROPERTY_KEYS) {
		const track = segment.tracks[key];
		if (track.length < 2) continue;
		const out = track[0].outEasing ?? DEFAULT_OUT_EASING;
		const into = track[track.length - 1].inEasing ?? DEFAULT_IN_EASING;
		return (
			MOTION_EASINGS.find(
				(easing) =>
					handlesMatch(easing.out, out) && handlesMatch(easing.in, into),
			) ?? LINEAR_MOTION_EASING
		);
	}
	return LINEAR_MOTION_EASING;
};

/** Retimes every track when the segment's length changes. */
export const scaleKeyframeTimes = (tracks: Camera3DTracks, scale: number) => {
	for (const key of CAMERA3D_TRACK_KEYS) {
		for (const keyframe of tracks[key]) keyframe.time *= scale;
	}
};

// -----------------------------------------------------------------------------
// CSS 3D preview
// -----------------------------------------------------------------------------

/**
 * Scale constant: the Flat preset (zoom 2, fov 45) lands at roughly 60% of the
 * preview card, which leaves room for the poses that push in closer.
 */
export const CAMERA3D_PREVIEW_SCALE_K = 0.5;

/**
 * A CSS-3D preview of a pose. The perspective distance reproduces the field
 * of view at this card height, the rotations run camera-then-plane in the
 * renderer's order, and apparent size follows 1 / (zoom * tan(fov/2)) exactly
 * like the real projection. Pan uses half the projected offset so the extreme
 * poses stay legible inside a thumbnail.
 */
export const cssPreviewTransform = (
	props: Camera3DProperties,
	containerHeightPx: number,
) => {
	const tan = Math.tan((clamp(props.fov, 1, 179) * Math.PI) / 360);
	const zoom = Math.max(props.zoom, 0.05);
	const scale = CAMERA3D_PREVIEW_SCALE_K / (zoom * tan);
	const offset = (containerHeightPx / 2) * scale;
	const tx = props.panX * offset;
	const ty = -props.panY * offset;

	return {
		perspective: containerHeightPx / (2 * tan),
		transform: [
			`translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`,
			`rotateY(${props.tiltY}deg)`,
			`rotateX(${-props.tiltX}deg)`,
			`rotateZ(${props.roll}deg)`,
			`rotateY(${props.rotateY}deg)`,
			`rotateX(${-props.rotateX}deg)`,
			`scale(${scale.toFixed(4)})`,
		].join(" "),
	};
};
