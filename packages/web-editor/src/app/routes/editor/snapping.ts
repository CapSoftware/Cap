export type NormRect = { x: number; y: number; w: number; h: number };

export type SnapLineKind =
	| "frame-edge"
	| "frame-center"
	| "margin"
	| "element-edge"
	| "element-center";

export type SnapLine = {
	pos: number;
	kind: SnapLineKind;
	refStart?: number;
	refEnd?: number;
};

export type SnapTargets = { v: SnapLine[]; h: SnapLine[] };

export type SnapGuide = {
	axis: "v" | "h";
	pos: number;
	start: number;
	end: number;
	kind: SnapLineKind;
};

export const SNAP_PX = 7;

export function buildSnapTargets(
	otherRects: NormRect[],
	opts?: { margin?: { x: number; y: number } },
): SnapTargets {
	const v: SnapLine[] = [
		{ pos: 0, kind: "frame-edge" },
		{ pos: 1, kind: "frame-edge" },
		{ pos: 0.5, kind: "frame-center" },
	];
	const h: SnapLine[] = [
		{ pos: 0, kind: "frame-edge" },
		{ pos: 1, kind: "frame-edge" },
		{ pos: 0.5, kind: "frame-center" },
	];

	const margin = opts?.margin;
	if (margin) {
		v.push(
			{ pos: margin.x, kind: "margin" },
			{ pos: 1 - margin.x, kind: "margin" },
		);
		h.push(
			{ pos: margin.y, kind: "margin" },
			{ pos: 1 - margin.y, kind: "margin" },
		);
	}

	for (const r of otherRects) {
		const refV = { refStart: r.y, refEnd: r.y + r.h };
		const refH = { refStart: r.x, refEnd: r.x + r.w };
		v.push(
			{ pos: r.x, kind: "element-edge", ...refV },
			{ pos: r.x + r.w / 2, kind: "element-center", ...refV },
			{ pos: r.x + r.w, kind: "element-edge", ...refV },
		);
		h.push(
			{ pos: r.y, kind: "element-edge", ...refH },
			{ pos: r.y + r.h / 2, kind: "element-center", ...refH },
			{ pos: r.y + r.h, kind: "element-edge", ...refH },
		);
	}

	return { v, h };
}

type AxisSnap = { delta: number; line: SnapLine } | null;

function snapAxis(
	anchors: number[],
	lines: SnapLine[],
	threshold: number,
): AxisSnap {
	let best: AxisSnap = null;
	let bestCost = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		const bias =
			line.kind === "frame-center" || line.kind === "element-center"
				? threshold * 0.15
				: 0;
		for (const anchor of anchors) {
			const delta = line.pos - anchor;
			if (Math.abs(delta) > threshold) continue;
			const cost = Math.abs(delta) - bias;
			if (cost < bestCost) {
				bestCost = cost;
				best = { delta, line };
			}
		}
	}
	return best;
}

function guideFor(
	axis: "v" | "h",
	line: SnapLine,
	moving: NormRect,
): SnapGuide {
	if (line.refStart === undefined || line.refEnd === undefined) {
		return { axis, pos: line.pos, start: 0, end: 1, kind: line.kind };
	}
	const movingStart = axis === "v" ? moving.y : moving.x;
	const movingEnd = axis === "v" ? moving.y + moving.h : moving.x + moving.w;
	return {
		axis,
		pos: line.pos,
		kind: line.kind,
		start: Math.min(line.refStart, movingStart),
		end: Math.max(line.refEnd, movingEnd),
	};
}

export function snapMovingRect(
	rect: NormRect,
	targets: SnapTargets,
	thresholdX: number,
	thresholdY: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
	const sx = snapAxis(
		[rect.x, rect.x + rect.w / 2, rect.x + rect.w],
		targets.v,
		thresholdX,
	);
	const sy = snapAxis(
		[rect.y, rect.y + rect.h / 2, rect.y + rect.h],
		targets.h,
		thresholdY,
	);

	const dx = sx?.delta ?? 0;
	const dy = sy?.delta ?? 0;
	const snapped = { ...rect, x: rect.x + dx, y: rect.y + dy };

	const guides: SnapGuide[] = [];
	if (sx) guides.push(guideFor("v", sx.line, snapped));
	if (sy) guides.push(guideFor("h", sy.line, snapped));

	return { dx, dy, guides };
}

export function snapResizeCorner(
	corner: { x: number; y: number },
	targets: SnapTargets,
	thresholdX: number,
	thresholdY: number,
): {
	axis: "x" | "y" | null;
	x: number;
	y: number;
	guides: SnapGuide[];
} {
	const sx = snapAxis([corner.x], targets.v, thresholdX);
	const sy = snapAxis([corner.y], targets.h, thresholdY);

	const useX =
		sx && (!sy || Math.abs(sx.delta) <= Math.abs(sy.delta)) ? sx : null;
	const useY = !useX && sy ? sy : null;

	if (useX) {
		return {
			axis: "x",
			x: corner.x + useX.delta,
			y: corner.y,
			guides: [
				{
					axis: "v",
					pos: useX.line.pos,
					start: 0,
					end: 1,
					kind: useX.line.kind,
				},
			],
		};
	}
	if (useY) {
		return {
			axis: "y",
			x: corner.x,
			y: corner.y + useY.delta,
			guides: [
				{
					axis: "h",
					pos: useY.line.pos,
					start: 0,
					end: 1,
					kind: useY.line.kind,
				},
			],
		};
	}
	return { axis: null, x: corner.x, y: corner.y, guides: [] };
}
