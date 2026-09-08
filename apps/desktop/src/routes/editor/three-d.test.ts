import { describe, expect, it } from "vitest";

import {
	ANGLE_PRESETS,
	anglePresetMotion,
	anglePresetPose,
	applyMotionTemplate,
	applySceneToRange,
	bezierEase,
	CAMERA3D_ANGLE_PRESET_KEYS,
	CAMERA3D_MIN_SHOT_DURATION,
	CAMERA3D_PROPERTY_KEYS,
	CAMERA3D_SCENES,
	CAMERA3D_TRACK_KEYS,
	type Camera3DKeyframe,
	type Camera3DProperties,
	type Camera3DScene,
	type Camera3DSegment,
	camera3DPosesEqual,
	DEFAULT_IN_EASING,
	DEFAULT_OUT_EASING,
	defaultCamera3DSegment,
	defaultCamera3DTracks,
	evaluatePose,
	fitCamera3DMotionToSegment,
	flipCamera3DSegment,
	getEndPose,
	getMotionEasing,
	getStartPose,
	hasCamera3DMotion,
	LINEAR_MOTION_EASING,
	MOTION_EASINGS,
	MOTION_TEMPLATES,
	normalizeCamera3DSegments,
	sampleTrack,
	sceneWithShotCount,
	setMotion,
	showcaseCamera3DBlur,
} from "./three-d";

const key = (
	time: number,
	value: number,
	handles?: Partial<Pick<Camera3DKeyframe, "outEasing" | "inEasing">>,
): Camera3DKeyframe => ({
	time,
	value,
	outEasing: handles?.outEasing ?? null,
	inEasing: handles?.inEasing ?? null,
});

const poseWith = (
	segment: Camera3DSegment,
	overrides: Partial<Camera3DProperties>,
): Camera3DProperties => ({ ...getStartPose(segment), ...overrides });

// Reading a pose back off a track is a lerp landing exactly on an endpoint, so
// the recovered value can differ from the authored one in the last bit.
const expectPose = (
	actual: Camera3DProperties,
	expected: Camera3DProperties,
) => {
	for (const property of CAMERA3D_PROPERTY_KEYS)
		expect(actual[property]).toBeCloseTo(expected[property], 9);
};

describe("sampleTrack", () => {
	it("returns the base value for an empty track", () => {
		expect(sampleTrack(7, [], 0)).toBe(7);
		expect(sampleTrack(7, [], 10)).toBe(7);
	});

	it("holds before the first and after the last keyframe", () => {
		const track = [key(1, 10), key(2, 20)];

		expect(sampleTrack(0, track, -5)).toBe(10);
		expect(sampleTrack(0, track, 1)).toBe(10);
		expect(sampleTrack(0, track, 2)).toBe(20);
		expect(sampleTrack(0, track, 99)).toBe(20);
	});

	it("sorts unsorted keyframes before sampling", () => {
		const track = [key(2, 20), key(1, 10)];

		expect(sampleTrack(0, track, 0)).toBe(10);
		expect(sampleTrack(0, track, 3)).toBe(20);
	});

	it("interpolates linearly with explicit [0,0] / [1,1] handles", () => {
		const track = [
			key(0, 0, { outEasing: [0, 0] }),
			key(1, 100, { inEasing: [1, 1] }),
		];

		expect(sampleTrack(0, track, 0.25)).toBeCloseTo(25, 6);
		expect(sampleTrack(0, track, 0.5)).toBeCloseTo(50, 6);
		expect(sampleTrack(0, track, 0.75)).toBeCloseTo(75, 6);
	});

	it("falls back to cubic ease in out when handles are absent", () => {
		const track = [key(0, 0), key(1, 100)];

		// cubic-bezier(0.65, 0, 0.35, 1) is symmetric: the midpoint is exact and
		// the quarter points bracket the linear values.
		expect(sampleTrack(0, track, 0.5)).toBeCloseTo(50, 4);
		expect(sampleTrack(0, track, 0.25)).toBeLessThan(25);
		expect(sampleTrack(0, track, 0.75)).toBeGreaterThan(75);
	});

	it("matches an explicit default-handle pair exactly", () => {
		const implicit = [key(0, 0), key(1, 100)];
		const explicit = [
			key(0, 0, { outEasing: [...DEFAULT_OUT_EASING] }),
			key(1, 100, { inEasing: [...DEFAULT_IN_EASING] }),
		];

		for (const t of [0.1, 0.33, 0.5, 0.8]) {
			expect(sampleTrack(0, implicit, t)).toBeCloseTo(
				sampleTrack(0, explicit, t),
				10,
			);
		}
	});

	it("reads the split handles from either side of the span", () => {
		const track = [
			key(0, 0, { outEasing: [0, 0] }),
			key(1, 100, { inEasing: [1, 1] }),
			key(2, 0),
		];

		// First span is explicitly linear, second falls back to the cubic ease.
		expect(sampleTrack(0, track, 0.5)).toBeCloseTo(50, 6);
		expect(sampleTrack(0, track, 1.5)).toBeCloseTo(50, 4);
	});
});

describe("bezierEase", () => {
	it("clamps outside the unit interval", () => {
		expect(bezierEase([0.65, 0], [0.35, 1], -1)).toBe(0);
		expect(bezierEase([0.65, 0], [0.35, 1], 2)).toBe(1);
	});

	it("takes the linear fast path for [0,0] / [1,1]", () => {
		expect(bezierEase([0, 0], [1, 1], 0.31)).toBe(0.31);
	});
});

describe("setMotion", () => {
	it("collapses equal poses to a still shot with no keyframes", () => {
		const segment = defaultCamera3DSegment(2, 6);
		const pose = poseWith(segment, { zoom: 1.4, tiltY: 12 });

		setMotion(segment, pose, { ...pose });

		for (const property of CAMERA3D_PROPERTY_KEYS) {
			expect(segment.tracks[property]).toEqual([]);
			expect(segment.properties[property]).toBe(pose[property]);
		}
		expect(hasCamera3DMotion(segment)).toBe(false);
	});

	it("keys only the properties that actually move", () => {
		const segment = defaultCamera3DSegment(2, 6);
		const start = getStartPose(segment);
		const end = { ...start, zoom: start.zoom + 1 };

		setMotion(segment, start, end);

		expect(segment.tracks.zoom).toHaveLength(2);
		expect(segment.tracks.zoom[0]).toMatchObject({
			time: 0,
			value: start.zoom,
		});
		expect(segment.tracks.zoom[1]).toMatchObject({ time: 4, value: end.zoom });
		expect(segment.tracks.tiltX).toEqual([]);
		expect(hasCamera3DMotion(segment)).toBe(true);
	});

	it("round-trips through getStartPose / getEndPose", () => {
		const segment = defaultCamera3DSegment(1, 5);
		const start = poseWith(segment, { zoom: 0.8, panX: -0.4, fov: 30 });
		const end = poseWith(segment, { zoom: 2.2, panX: 0.5, fov: 60, roll: 8 });

		setMotion(segment, start, end);

		expectPose(getStartPose(segment), start);
		expectPose(getEndPose(segment), end);
	});

	it("recovers the poses of an old multi-keyframe segment and flattens them", () => {
		const segment = defaultCamera3DSegment(0, 4);
		// Three keyframes with a detour in the middle, as the old record-mode UX
		// could author.
		segment.tracks.zoom = [key(0, 1), key(1.5, 3), key(4, 2)];
		segment.tracks.panX = [key(0, -0.5), key(4, 0.5)];

		const start = getStartPose(segment);
		const end = getEndPose(segment);
		expect(start.zoom).toBe(1);
		expect(end.zoom).toBe(2);
		expect(start.panX).toBe(-0.5);
		expect(end.panX).toBe(0.5);

		setMotion(segment, start, end);

		expect(segment.tracks.zoom).toHaveLength(2);
		expectPose(getStartPose(segment), start);
		expectPose(getEndPose(segment), end);
	});

	it("never touches the blur config or its tracks", () => {
		const segment = defaultCamera3DSegment(0, 4);
		segment.tracks.blurStrength = [key(0, 5), key(4, 9)];
		const blur = { ...segment.blur };

		setMotion(
			segment,
			getStartPose(segment),
			poseWith(segment, { zoom: 3 }),
			MOTION_EASINGS[1],
		);

		expect(segment.blur).toEqual(blur);
		expect(segment.tracks.blurStrength).toEqual([key(0, 5), key(4, 9)]);
	});
});

describe("MOTION_EASINGS", () => {
	it("defaults to linear", () => {
		expect(LINEAR_MOTION_EASING).toBe(MOTION_EASINGS[0]);
		expect(LINEAR_MOTION_EASING.out).toEqual([0, 0]);
		expect(LINEAR_MOTION_EASING.in).toEqual([1, 1]);
		expect(MOTION_EASINGS.map((easing) => easing.label)).toEqual([
			"Linear",
			"Smooth",
			"Ease in",
			"Ease out",
		]);
	});

	it("writes and reads back every style", () => {
		for (const easing of MOTION_EASINGS) {
			const segment = defaultCamera3DSegment(0, 4);
			const start = getStartPose(segment);
			const end = { ...start, zoom: start.zoom + 1 };

			setMotion(segment, start, end, easing);

			expect(segment.tracks.zoom[0].outEasing).toEqual(easing.out);
			expect(segment.tracks.zoom[1].inEasing).toEqual(easing.in);
			expect(getMotionEasing(segment)).toBe(easing);
		}
	});

	it("reads a still shot and an unrecognised curve as linear", () => {
		const still = defaultCamera3DSegment(0, 4);
		expect(getMotionEasing(still)).toBe(LINEAR_MOTION_EASING);

		const custom = defaultCamera3DSegment(0, 4);
		custom.tracks.zoom = [
			key(0, 1, { outEasing: [0.11, 0.22] }),
			key(4, 2, { inEasing: [0.33, 0.44] }),
		];
		expect(getMotionEasing(custom)).toBe(LINEAR_MOTION_EASING);
	});
});

describe("camera3DPosesEqual", () => {
	it("ignores differences finer than a still shot", () => {
		const segment = defaultCamera3DSegment(0, 4);
		const pose = getStartPose(segment);

		expect(camera3DPosesEqual(pose, { ...pose, zoom: pose.zoom + 1e-6 })).toBe(
			true,
		);
		expect(camera3DPosesEqual(pose, { ...pose, zoom: pose.zoom + 0.01 })).toBe(
			false,
		);
	});
});

describe("ANGLE_PRESETS", () => {
	it("ships the five angle presets", () => {
		expect(ANGLE_PRESETS.map((preset) => preset.id)).toEqual([
			"spotlight",
			"perspective",
			"center",
			"low-angle",
			"close-up",
		]);
	});

	it("never writes the content plane rotations", () => {
		for (const preset of ANGLE_PRESETS) {
			expect(Object.keys(preset.values).sort()).toEqual(
				[...CAMERA3D_ANGLE_PRESET_KEYS].sort(),
			);
			expect(preset.values).not.toHaveProperty("rotateX");
			expect(preset.values).not.toHaveProperty("rotateY");
		}
	});

	it("every angle preset is a moving shot opening on its named pose", () => {
		for (const preset of ANGLE_PRESETS) {
			const motion = anglePresetMotion(preset);
			expect(motion.from).toEqual(anglePresetPose(preset));
			// The drift only touches pose keys and actually moves something.
			expect(Object.keys(preset.drift).length).toBeGreaterThan(0);
			for (const key of Object.keys(preset.drift))
				expect(CAMERA3D_ANGLE_PRESET_KEYS).toContain(key);
			expect(motion.to).not.toEqual(motion.from);
			expect(motion.to.rotateX).toBe(0);
			expect(motion.to.rotateY).toBe(0);
		}
	});

	it("applying an angle preset writes keyframes like a motion template", () => {
		const preset = ANGLE_PRESETS.find((p) => p.id === "perspective");
		expect(preset).toBeDefined();
		if (!preset) return;

		const segment = defaultCamera3DSegment(2, 6);
		applyMotionTemplate(segment, anglePresetMotion(preset));

		expect(segment.tracks.tiltY).toHaveLength(2);
		expect(segment.tracks.tiltY[0]).toMatchObject({ time: 0, value: 26 });
		expect(segment.tracks.tiltY[1]).toMatchObject({ time: 4, value: 18 });
		expect(segment.tracks.zoom[1].value).toBeCloseTo(1.53);
		expect(segment.transitionIn).toBe(0);
		expect(segment.transitionOut).toBe(0);
	});
});

describe("MOTION_TEMPLATES", () => {
	it("ships eight templates with unique ids", () => {
		expect(MOTION_TEMPLATES).toHaveLength(8);
		expect(new Set(MOTION_TEMPLATES.map((t) => t.id)).size).toBe(8);
	});

	it("writes two explicitly linear keyframes on every moving camera track", () => {
		for (const template of MOTION_TEMPLATES) {
			const segment = defaultCamera3DSegment(2, 6);
			applyMotionTemplate(segment, template);

			expectPose(getStartPose(segment), template.from);
			expectPose(getEndPose(segment), template.to);
			expect(getMotionEasing(segment)).toBe(LINEAR_MOTION_EASING);

			for (const property of CAMERA3D_PROPERTY_KEYS) {
				const track = segment.tracks[property];
				// A property the template holds still carries no keyframes at all.
				if (template.from[property] === template.to[property]) {
					expect(track).toEqual([]);
					expect(segment.properties[property]).toBe(template.from[property]);
					continue;
				}
				expect(track).toHaveLength(2);
				expect(track[0].time).toBe(0);
				expect(track[1].time).toBe(4);
				expect(track[0].value).toBe(template.from[property]);
				expect(track[1].value).toBe(template.to[property]);
				expect(track[0].outEasing).toEqual([0, 0]);
				expect(track[1].inEasing).toEqual([1, 1]);
			}

			// Blur tracks are the user's, so a template must not touch them.
			for (const trackKey of CAMERA3D_TRACK_KEYS) {
				if ((CAMERA3D_PROPERTY_KEYS as readonly string[]).includes(trackKey))
					continue;
				expect(segment.tracks[trackKey]).toEqual([]);
			}
		}
	});

	it("cuts into the move by clearing any transition the segment carried", () => {
		const segment = defaultCamera3DSegment(0, 4);
		segment.transitionIn = 0.3;
		segment.transitionOut = 0.3;

		applyMotionTemplate(segment, MOTION_TEMPLATES[0]);

		expect(segment.transitionIn).toBe(0);
		expect(segment.transitionOut).toBe(0);
	});

	it("samples linearly between the two poses", () => {
		const template = MOTION_TEMPLATES[0];
		const segment = defaultCamera3DSegment(0, 4);
		applyMotionTemplate(segment, template);

		expect(sampleTrack(0, segment.tracks.panX, 2)).toBeCloseTo(
			(template.from.panX + template.to.panX) / 2,
			6,
		);
	});
});

describe("template blur", () => {
	const cards = () => [
		...ANGLE_PRESETS.map((preset) => anglePresetMotion(preset)),
		...MOTION_TEMPLATES,
	];

	it("gives every card a complete radial look", () => {
		for (const card of cards()) {
			expect(card.blur.mode).toBe("radial");
			expect(card.blur.bokeh).toBe(true);
			expect(card.blur.angle).toBe(0);
			expect(card.blur.dirPosition).toBe(0.5);
			expect(card.blur.strength).toBeGreaterThan(0);
		}
	});

	it("uses the showcase defocus everywhere but the two authored exceptions", () => {
		const detail = {
			mode: "radial",
			strength: 20,
			falloff: 0.76,
			focusX: 0.11,
			focusY: 0.5,
			focusSize: 0.18,
			angle: 0,
			dirPosition: 0.5,
			bokeh: true,
		};
		const overhead = {
			mode: "radial",
			strength: 18,
			falloff: 0.72,
			focusX: 0.03,
			focusY: 0.36,
			focusSize: 0.55,
			angle: 0,
			dirPosition: 0.5,
			bokeh: true,
		};

		for (const card of cards()) {
			if (card.id === "angle-close-up") expect(card.blur).toEqual(detail);
			else if (card.id === "top-down") expect(card.blur).toEqual(overhead);
			else expect(card.blur).toEqual(showcaseCamera3DBlur());
		}
	});

	it("writes the card's blur onto the segment, replacing whatever was there", () => {
		const overhead = MOTION_TEMPLATES.find((t) => t.id === "top-down");
		expect(overhead).toBeDefined();
		if (!overhead) return;

		const segment = defaultCamera3DSegment(0, 4);
		segment.blur = { ...segment.blur, mode: "directional", strength: 3 };

		applyMotionTemplate(segment, overhead);

		expect(segment.blur).toEqual(overhead.blur);
		// A copy, so editing the segment never mutates the template.
		expect(segment.blur).not.toBe(overhead.blur);
	});
});

describe("CAMERA3D_SCENES", () => {
	it("ships three scenes with unique ids and three shots each", () => {
		expect(CAMERA3D_SCENES.map((scene) => scene.id)).toEqual([
			"showcase",
			"product-tour",
			"punch-in",
		]);
		expect(new Set(CAMERA3D_SCENES.map((scene) => scene.id)).size).toBe(3);
		for (const scene of CAMERA3D_SCENES) expect(scene.shots).toHaveLength(3);
	});

	it("gives every scene weights that fill its range and a blur per shot", () => {
		for (const scene of CAMERA3D_SCENES) {
			const total = scene.shots.reduce((sum, shot) => sum + shot.weight, 0);
			expect(total).toBeCloseTo(1, 6);
			for (const shot of scene.shots) {
				expect(shot.weight).toBeGreaterThan(0);
				expect(shot.blur.mode).toBe("radial");
				expect(shot.blur.bokeh).toBe(true);
			}
		}
	});

	it("matches the reference project's showcase values verbatim", () => {
		const showcase = CAMERA3D_SCENES.find((scene) => scene.id === "showcase");
		expect(showcase).toBeDefined();
		if (!showcase) return;

		const [close, overhead, push] = showcase.shots;

		expect(close.weight).toBe(0.27);
		expect(close.from).toEqual({
			tiltX: 26,
			tiltY: -22,
			roll: 1,
			rotateX: 0,
			rotateY: 0,
			fov: 45,
			zoom: 0.8,
			panX: -0.3,
			panY: -0.4,
		});
		expect(close.to).toEqual({ ...close.from, tiltY: -27, panX: -0.36 });
		expect(close.blur).toEqual({
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

		expect(overhead.weight).toBe(0.25);
		expect(overhead.from).toEqual({
			tiltX: 24.8,
			tiltY: 17.04,
			roll: 0,
			rotateX: -40,
			rotateY: 18,
			fov: 60,
			zoom: 0.5,
			panX: -0.065,
			panY: -0.195,
		});
		expect(overhead.to).toEqual({
			...overhead.from,
			tiltX: 34.19,
			tiltY: 15.28,
			rotateY: 9,
			panX: -0.217,
			panY: -0.476,
		});
		expect(overhead.blur).toEqual({
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

		expect(push.weight).toBe(0.48);
		expect(push.from).toEqual({
			tiltX: 0,
			tiltY: 0,
			roll: 0,
			rotateX: -14,
			rotateY: 0,
			fov: 45,
			zoom: 0.715,
			panX: 0,
			panY: 0,
		});
		expect(push.to).toEqual({ ...push.from, zoom: 1.6 });
		expect(push.blur).toEqual({
			mode: "radial",
			strength: 19,
			falloff: 0.67,
			focusX: 0.37,
			focusY: 0.52,
			focusSize: 0.4,
			angle: 0,
			dirPosition: 0.5,
			bokeh: true,
		});
	});

	it("builds the derived scenes out of the existing card looks", () => {
		const tour = CAMERA3D_SCENES.find((scene) => scene.id === "product-tour");
		const punch = CAMERA3D_SCENES.find((scene) => scene.id === "punch-in");
		expect(tour).toBeDefined();
		expect(punch).toBeDefined();
		if (!tour || !punch) return;

		const template = (id: string) => {
			const found = MOTION_TEMPLATES.find((t) => t.id === id);
			expect(found).toBeDefined();
			return found;
		};
		const preset = (id: string) => {
			const found = ANGLE_PRESETS.find((p) => p.id === id);
			expect(found).toBeDefined();
			return found ? anglePresetMotion(found) : undefined;
		};

		const expectShot = (
			shot: (typeof tour.shots)[number],
			card: ReturnType<typeof template>,
			weight: number,
		) => {
			expect(card).toBeDefined();
			if (!card) return;
			expect(shot.weight).toBe(weight);
			expect(shot.from).toEqual(card.from);
			expect(shot.to).toEqual(card.to);
			expect(shot.blur).toEqual(card.blur);
		};

		expectShot(tour.shots[0], template("unfold"), 0.3);
		expectShot(tour.shots[1], preset("perspective"), 0.3);
		expectShot(tour.shots[2], preset("center"), 0.4);

		expectShot(punch.shots[0], preset("spotlight"), 0.3);
		expectShot(punch.shots[1], preset("close-up"), 0.3);
		expectShot(punch.shots[2], template("pull-back"), 0.4);
	});
});

describe("sceneWithShotCount", () => {
	const showcase = CAMERA3D_SCENES[0];

	it("keeps the leading shots and renormalizes their weights", () => {
		const two = sceneWithShotCount(showcase, 2);

		expect(two.shots).toHaveLength(2);
		expect(two.shots[0].weight).toBeCloseTo(0.27 / 0.52, 9);
		expect(two.shots[1].weight).toBeCloseTo(0.25 / 0.52, 9);
		expect(two.shots.reduce((sum, shot) => sum + shot.weight, 0)).toBeCloseTo(
			1,
			9,
		);
		// Only the weight changes: the look and the move are the scene's.
		expect(two.shots[0].from).toEqual(showcase.shots[0].from);
		expect(two.shots[0].to).toEqual(showcase.shots[0].to);
		expect(two.shots[1].blur).toEqual(showcase.shots[1].blur);
		expect(two.id).toBe(showcase.id);
	});

	it("gives a single shot the whole range", () => {
		const one = sceneWithShotCount(showcase, 1);

		expect(one.shots).toHaveLength(1);
		expect(one.shots[0].weight).toBeCloseTo(1, 9);
		expect(one.shots[0].from).toEqual(showcase.shots[0].from);
	});

	it("clamps a count outside the scene's shots", () => {
		expect(sceneWithShotCount(showcase, 0).shots).toHaveLength(1);
		expect(sceneWithShotCount(showcase, -3).shots).toHaveLength(1);
		expect(sceneWithShotCount(showcase, 2.7).shots).toHaveLength(2);
		expect(sceneWithShotCount(showcase, 3)).toBe(showcase);
		expect(sceneWithShotCount(showcase, 99)).toBe(showcase);
	});

	it("never mutates the scene it truncates", () => {
		const before = showcase.shots.map((shot) => shot.weight);

		sceneWithShotCount(showcase, 1);
		sceneWithShotCount(showcase, 2);

		expect(showcase.shots.map((shot) => shot.weight)).toEqual(before);
	});
});

describe("applySceneToRange", () => {
	const showcase = CAMERA3D_SCENES[0];

	const boundariesOf = (segments: Camera3DSegment[]) => [
		segments[0].start,
		...segments.map((segment) => segment.end),
	];

	it("splits a range by shot weight", () => {
		const segments = applySceneToRange(showcase, 0, 10, []);

		expect(segments).toHaveLength(3);
		const boundaries = boundariesOf(segments);
		expect(boundaries[0]).toBeCloseTo(0, 9);
		expect(boundaries[1]).toBeCloseTo(2.7, 9);
		expect(boundaries[2]).toBeCloseTo(5.2, 9);
		expect(boundaries[3]).toBeCloseTo(10, 9);
	});

	it("lays the shots end to end with no gaps, wherever the range starts", () => {
		const segments = applySceneToRange(showcase, 4, 14, []);

		expect(segments[0].start).toBe(4);
		expect(segments[segments.length - 1].end).toBe(14);
		for (let index = 1; index < segments.length; index++)
			expect(segments[index].start).toBe(segments[index - 1].end);
	});

	it("snaps an interior boundary onto a nearby clip cut", () => {
		const segments = applySceneToRange(showcase, 0, 11.14, [3.03]);

		expect(segments).toHaveLength(3);
		expect(segments[0].end).toBe(3.03);
		expect(segments[1].start).toBe(3.03);
		// The far boundary had no cut within reach, so it stays on its weight.
		expect(segments[1].end).toBeCloseTo(11.14 * 0.52, 9);
	});

	it("ignores a cut further than the snap window away", () => {
		// Window is 15% of the 10s range, and 6.9 is out of reach of both the
		// 2.7 and the 5.2 boundary.
		const segments = applySceneToRange(showcase, 0, 10, [6.9]);

		expect(segments[0].end).toBeCloseTo(2.7, 9);
		expect(segments[1].end).toBeCloseTo(5.2, 9);
	});

	it("drops a snap that would leave a shot under the minimum", () => {
		// Range fits three shots with almost nothing to spare, so the last
		// boundary cannot travel to the cut even though it is within the window.
		const segments = applySceneToRange(showcase, 0, 3.4, [2.45]);

		expect(segments).toHaveLength(3);
		expect(segments[1].end).toBeCloseTo(2, 9);
		for (const segment of segments)
			expect(segment.end - segment.start).toBeGreaterThanOrEqual(
				CAMERA3D_MIN_SHOT_DURATION - 1e-9,
			);
	});

	it("takes a snap that keeps every shot long enough", () => {
		const segments = applySceneToRange(showcase, 0, 3.4, [2.3]);

		expect(segments[1].end).toBe(2.3);
	});

	it("drops trailing shots a short range cannot fit", () => {
		const segments = applySceneToRange(showcase, 0, 2.5, []);

		expect(segments).toHaveLength(2);
		expect(segments[0].start).toBe(0);
		expect(segments[segments.length - 1].end).toBe(2.5);
		for (const segment of segments)
			expect(segment.end - segment.start).toBeGreaterThanOrEqual(
				CAMERA3D_MIN_SHOT_DURATION - 1e-9,
			);
		// The leading shots are kept, re-weighted onto the whole range.
		expectPose(getStartPose(segments[0]), showcase.shots[0].from);
		expectPose(getEndPose(segments[1]), showcase.shots[1].to);
	});

	it("never drops below one shot, and refuses an empty range", () => {
		expect(applySceneToRange(showcase, 0, 0.4, [])).toHaveLength(1);
		expect(applySceneToRange(showcase, 5, 5, [])).toEqual([]);
		expect(applySceneToRange(showcase, 5, 1, [])).toEqual([]);
	});

	it("fills the range with a scene truncated to fewer shots", () => {
		const two = applySceneToRange(sceneWithShotCount(showcase, 2), 0, 10, []);

		expect(two).toHaveLength(2);
		expect(two[0].start).toBe(0);
		expect(two[0].end).toBeCloseTo(10 * (0.27 / 0.52), 9);
		expect(two[1].start).toBe(two[0].end);
		expect(two[1].end).toBe(10);
		expectPose(getStartPose(two[0]), showcase.shots[0].from);
		expectPose(getEndPose(two[1]), showcase.shots[1].to);

		const one = applySceneToRange(sceneWithShotCount(showcase, 1), 0, 10, []);

		expect(one).toHaveLength(1);
		expect(one[0].start).toBe(0);
		expect(one[0].end).toBe(10);
		expectPose(getStartPose(one[0]), showcase.shots[0].from);
		expectPose(getEndPose(one[0]), showcase.shots[0].to);
	});

	it("still truncates a scene the range cannot fit", () => {
		// Two shots asked for, one second of room: the fallback inside
		// applySceneToRange drops the shot that would not read as a cut.
		const segments = applySceneToRange(
			sceneWithShotCount(showcase, 2),
			0,
			1.5,
			[],
		);

		expect(segments).toHaveLength(1);
		expect(segments[0].start).toBe(0);
		expect(segments[0].end).toBe(1.5);
	});

	it("writes each shot's move, look and cut for every scene", () => {
		for (const scene of CAMERA3D_SCENES) {
			const segments = applySceneToRange(scene, 0, 30, []);
			expect(segments).toHaveLength(scene.shots.length);

			segments.forEach((segment, index) => {
				const shot = scene.shots[index];

				expect(segment.enabled).toBe(true);
				expect(segment.transitionIn).toBe(0);
				expect(segment.transitionOut).toBe(0);
				expect(segment.blur).toEqual(shot.blur);
				// A copy: editing one shot must not touch the scene data.
				expect(segment.blur).not.toBe(shot.blur);

				expectPose(getStartPose(segment), shot.from);
				expectPose(getEndPose(segment), shot.to);
				expect(hasCamera3DMotion(segment)).toBe(
					!camera3DPosesEqual(shot.from, shot.to),
				);
				if (hasCamera3DMotion(segment))
					expect(getMotionEasing(segment)).toBe(LINEAR_MOTION_EASING);

				// Motion always spans the shot it was written onto.
				for (const property of CAMERA3D_PROPERTY_KEYS) {
					const track = segment.tracks[property];
					if (track.length === 0) continue;
					expect(track[0].time).toBe(0);
					expect(track[1].time).toBeCloseTo(segment.end - segment.start, 9);
				}
			});
		}
	});

	it("holds a still shot as a plain pose", () => {
		const still: Camera3DScene = {
			id: "still",
			name: "Still",
			shots: [
				{
					weight: 1,
					from: anglePresetPose(ANGLE_PRESETS[0]),
					to: anglePresetPose(ANGLE_PRESETS[0]),
					blur: showcaseCamera3DBlur(),
				},
			],
		};

		const [segment] = applySceneToRange(still, 0, 5, []);

		expect(hasCamera3DMotion(segment)).toBe(false);
		expectPose(getStartPose(segment), anglePresetPose(ANGLE_PRESETS[0]));
	});
});

describe("split continuity", () => {
	// Mirrors projectActions.splitCamera3DSegment: both halves have to meet on
	// the pose the original segment held at the cut.
	const split = (segment: Camera3DSegment, time: number) => {
		const startPose = getStartPose(segment);
		const midPose = evaluatePose(segment, time);
		const endPose = getEndPose(segment);
		const easing = getMotionEasing(segment);

		const right: Camera3DSegment = {
			...segment,
			start: segment.start + time,
			properties: { ...segment.properties },
			blur: { ...segment.blur },
			tracks: defaultCamera3DTracks(),
		};
		setMotion(right, midPose, endPose, easing);

		const left: Camera3DSegment = {
			...segment,
			end: segment.start + time,
			properties: { ...segment.properties },
			blur: { ...segment.blur },
			tracks: defaultCamera3DTracks(),
		};
		setMotion(left, startPose, midPose, easing);

		return { left, right, midPose };
	};

	it("keeps the pose at the cut identical on both halves", () => {
		const segment = defaultCamera3DSegment(0, 4);
		applyMotionTemplate(segment, MOTION_TEMPLATES[3]);

		const { left, right, midPose } = split(segment, 1.5);

		expectPose(getEndPose(left), midPose);
		expectPose(getStartPose(right), midPose);
		expectPose(getStartPose(left), getStartPose(segment));
		expectPose(getEndPose(right), getEndPose(segment));
	});

	it("re-times both halves onto their own length", () => {
		const segment = defaultCamera3DSegment(0, 4);
		applyMotionTemplate(segment, MOTION_TEMPLATES[3]);

		const { left, right } = split(segment, 1.5);

		expect(left.tracks.zoom[1].time).toBeCloseTo(1.5, 10);
		expect(right.tracks.zoom[1].time).toBeCloseTo(2.5, 10);
	});

	it("leaves a still shot still on both sides", () => {
		const segment = defaultCamera3DSegment(0, 4);

		const { left, right } = split(segment, 2);

		expect(hasCamera3DMotion(left)).toBe(false);
		expect(hasCamera3DMotion(right)).toBe(false);
		expectPose(getStartPose(right), getStartPose(segment));
	});
});

describe("normalizeCamera3DSegments", () => {
	it("fills every default and gives each track an array", () => {
		const [segment] = normalizeCamera3DSegments([{ start: 1, end: 3 }]);

		expect(segment.enabled).toBe(true);
		expect(segment.properties.fov).toBe(45);
		expect(segment.properties.zoom).toBe(2);
		expect(segment.blur.mode).toBe("none");
		expect(segment.blur.focusX).toBe(0.37);
		// Absent transitions mean a clean cut, matching the renderer's default.
		expect(segment.transitionIn).toBe(0);
		expect(segment.transitionOut).toBe(0);
		for (const trackKey of CAMERA3D_TRACK_KEYS)
			expect(segment.tracks[trackKey]).toEqual([]);
	});

	it("sorts keyframes and normalizes absent handles to null", () => {
		const [segment] = normalizeCamera3DSegments([
			{
				start: 0,
				end: 2,
				tracks: {
					...defaultCamera3DTracks(),
					zoom: [
						{ time: 1, value: 3 },
						{ time: 0, value: 1 },
					],
				},
			},
		]);

		// Sorted, and the stale 1s span is stretched onto the 2s segment by
		// the fit-on-load invariant.
		expect(segment.tracks.zoom.map((k) => k.time)).toEqual([0, 2]);
		expect(segment.tracks.zoom[0].outEasing).toBeNull();
		expect(segment.tracks.zoom[0].inEasing).toBeNull();
	});
});

describe("defaultCamera3DSegment", () => {
	it("opens on the Angled pose so the 3D look is visible immediately", () => {
		const segment = defaultCamera3DSegment(0, 5);
		const angled = ANGLE_PRESETS.find((preset) => preset.id === "perspective");

		expect(angled).toBeDefined();
		for (const property of CAMERA3D_ANGLE_PRESET_KEYS)
			expect(segment.properties[property]).toBe(angled?.values[property]);
		expect(segment.properties.rotateX).toBe(0);
		expect(segment.properties.rotateY).toBe(0);
	});

	it("opens on the showcase blur so the cinematic look is on by default", () => {
		expect(defaultCamera3DSegment(0, 5).blur).toEqual(showcaseCamera3DBlur());
		expect(showcaseCamera3DBlur()).toMatchObject({
			mode: "radial",
			strength: 19,
			falloff: 0.62,
			bokeh: true,
			focusX: 0.37,
			focusY: 0.5,
			focusSize: 0.4,
		});
	});

	it("is a still shot with no keyframes until something moves it", () => {
		const segment = defaultCamera3DSegment(0, 5);

		expect(hasCamera3DMotion(segment)).toBe(false);
		expectPose(getStartPose(segment), getEndPose(segment));
	});

	it("cuts straight in and out, with no ramp either side", () => {
		const segment = defaultCamera3DSegment(0, 5);

		expect(segment.transitionIn).toBe(0);
		expect(segment.transitionOut).toBe(0);
	});
});

describe("fitCamera3DMotionToSegment", () => {
	it("rescales track times onto the segment duration after a resize", () => {
		const segment = defaultCamera3DSegment(0, 4);
		setMotion(segment, getStartPose(segment), poseWith(segment, { zoom: 3 }));

		// A trim shortened the segment; keyframes still span the old 4s.
		segment.end = 2.5;
		fitCamera3DMotionToSegment(segment);

		expect(segment.tracks.zoom[1].time).toBeCloseTo(2.5, 9);
		// Applying again is a no-op (safe during live drags).
		fitCamera3DMotionToSegment(segment);
		expect(segment.tracks.zoom[1].time).toBeCloseTo(2.5, 9);
	});

	it("repairs stale spans on load through normalize", () => {
		const segment = defaultCamera3DSegment(0, 3.025);
		segment.tracks.tiltY = [
			{ time: 0, value: -22, outEasing: [0, 0], inEasing: null },
			{ time: 4.8625, value: -27, outEasing: null, inEasing: [1, 1] },
		];

		const [normalized] = normalizeCamera3DSegments([segment]);
		expect(normalized.tracks.tiltY[1].time).toBeCloseTo(3.025, 9);
	});

	it("leaves still segments alone", () => {
		const segment = defaultCamera3DSegment(0, 4);
		fitCamera3DMotionToSegment(segment);
		for (const track of Object.values(segment.tracks))
			expect(track).toEqual([]);
	});
});

describe("flipCamera3DSegment", () => {
	it("mirrors the pose family, tracks, and blur focus horizontally", () => {
		const segment = defaultCamera3DSegment(0, 4);
		setMotion(
			segment,
			poseWith(segment, { tiltY: 26, roll: 5, panX: 0.37, rotateY: 18 }),
			poseWith(segment, { tiltY: 18, roll: 5, panX: 0.2, rotateY: 9 }),
		);
		segment.blur.focusX = 0.11;
		segment.blur.angle = 30;

		flipCamera3DSegment(segment, "horizontal");

		expect(getStartPose(segment).tiltY).toBeCloseTo(-26, 9);
		expect(getEndPose(segment).tiltY).toBeCloseTo(-18, 9);
		expect(getStartPose(segment).panX).toBeCloseTo(-0.37, 9);
		expect(getStartPose(segment).rotateY).toBeCloseTo(-18, 9);
		expect(getStartPose(segment).roll).toBeCloseTo(-5, 9);
		// Vertical family untouched (the default segment opens on Perspective).
		expect(getStartPose(segment).tiltX).toBeCloseTo(-28, 9);
		expect(segment.blur.focusX).toBeCloseTo(0.89, 9);
		expect(segment.blur.angle).toBeCloseTo(150, 9);

		// Flipping twice restores the original.
		flipCamera3DSegment(segment, "horizontal");
		expect(getStartPose(segment).tiltY).toBeCloseTo(26, 9);
		expect(segment.blur.focusX).toBeCloseTo(0.11, 9);
		expect(segment.blur.angle).toBeCloseTo(30, 9);
	});

	it("mirrors the vertical family and focus Y", () => {
		const segment = defaultCamera3DSegment(0, 4);
		setMotion(
			segment,
			poseWith(segment, { tiltX: -50, panY: -0.4, rotateX: -14 }),
			poseWith(segment, { tiltX: -44, panY: -0.2, rotateX: -14 }),
		);
		segment.blur.focusY = 0.36;

		flipCamera3DSegment(segment, "vertical");

		expect(getStartPose(segment).tiltX).toBeCloseTo(50, 9);
		expect(getEndPose(segment).tiltX).toBeCloseTo(44, 9);
		expect(getStartPose(segment).panY).toBeCloseTo(0.4, 9);
		expect(getStartPose(segment).rotateX).toBeCloseTo(14, 9);
		// Horizontal family untouched.
		expect(getStartPose(segment).tiltY).toBeCloseTo(26, 9);
		expect(segment.blur.focusY).toBeCloseTo(0.64, 9);
	});
});
