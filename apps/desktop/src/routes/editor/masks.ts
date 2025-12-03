import type { XY } from "~/utils/tauri";

export type MaskKind = "sensitive" | "highlight";

export type MaskScalarKeyframe = {
	time: number;
	value: number;
};

export type MaskVectorKeyframe = {
	time: number;
	x: number;
	y: number;
};

export type MaskKeyframes = {
	position: MaskVectorKeyframe[];
	size: MaskVectorKeyframe[];
	intensity: MaskScalarKeyframe[];
};

export type MaskSegment = {
	start: number;
	end: number;
	enabled: boolean;
	maskType: MaskKind;
	center: XY<number>;
	size: XY<number>;
	feather: number;
	opacity: number;
	pixelation: number;
	darkness: number;
	keyframes: MaskKeyframes;
};

export type MaskState = {
	position: XY<number>;
	size: XY<number>;
	intensity: number;
};

export const defaultMaskSegment = (
	start: number,
	end: number,
): MaskSegment => ({
	start,
	end,
	enabled: true,
	maskType: "sensitive",
	center: { x: 0.5, y: 0.5 },
	size: { x: 0.35, y: 0.35 },
	feather: 0.1,
	opacity: 1,
	pixelation: 18,
	darkness: 0.5,
	keyframes: { position: [], size: [], intensity: [] },
});

export const evaluateMask = (
	segment: MaskSegment,
	_time?: number,
): MaskState => {
	const position = {
		x: Math.min(Math.max(segment.center.x, 0), 1),
		y: Math.min(Math.max(segment.center.y, 0), 1),
	};
	const size = {
		x: Math.min(Math.max(segment.size.x, 0.01), 2),
		y: Math.min(Math.max(segment.size.y, 0.01), 2),
	};
	const intensity = Math.min(Math.max(segment.opacity, 0), 1);

	return { position, size, intensity };
};

const sortByTime = <T extends { time: number }>(items: T[]) =>
	[...items].sort((a, b) => a.time - b.time);

const timeMatch = (a: number, b: number) => Math.abs(a - b) < 1e-3;

export const upsertVectorKeyframe = (
	keyframes: MaskVectorKeyframe[],
	time: number,
	value: XY<number>,
) => {
	const existingIndex = keyframes.findIndex((k) => timeMatch(k.time, time));
	if (existingIndex >= 0) {
		const next = [...keyframes];
		next[existingIndex] = {
			...next[existingIndex],
			time,
			x: value.x,
			y: value.y,
		};
		return sortByTime(next);
	}
	return sortByTime([...keyframes, { time, x: value.x, y: value.y }]);
};

export const upsertScalarKeyframe = (
	keyframes: MaskScalarKeyframe[],
	time: number,
	value: number,
) => {
	const existingIndex = keyframes.findIndex((k) => timeMatch(k.time, time));
	if (existingIndex >= 0) {
		const next = [...keyframes];
		next[existingIndex] = { ...next[existingIndex], time, value };
		return sortByTime(next);
	}
	return sortByTime([...keyframes, { time, value }]);
};

export const removeKeyframeAt = <T extends { time: number }>(
	items: T[],
	time: number,
) => items.filter((k) => !timeMatch(k.time, time));
