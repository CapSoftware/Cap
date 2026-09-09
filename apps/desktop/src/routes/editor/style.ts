import type { ProjectConfiguration, StyleSegment } from "~/utils/tauri";

export type StyleGroup = "background" | "camera" | "cursor";
export type { StyleSegment } from "~/utils/tauri";

export function defaultStyleSegment(
	start: number,
	end: number,
	track = 0,
): StyleSegment {
	return {
		start,
		end,
		track,
		enabled: true,
		name: "Style",
		overrides: {
			background: null,
			camera: null,
			cursor: null,
			cameraOnlyPadding: null,
		},
	};
}

export function activeStyleSegments(
	segments: readonly StyleSegment[],
	time: number,
) {
	return segments
		.map((segment, index) => ({ segment, index }))
		.filter(
			({ segment }) =>
				segment.enabled &&
				Number.isFinite(time) &&
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.start >= 0 &&
				segment.end > segment.start &&
				time >= segment.start &&
				time < segment.end,
		)
		.sort(
			(a, b) =>
				a.segment.track - b.segment.track ||
				a.segment.start - b.segment.start ||
				a.index - b.index,
		);
}

export function resolveStyle<T extends Pick<ProjectConfiguration, StyleGroup>>(
	base: T,
	segments: readonly StyleSegment[],
	time: number,
): T {
	const result = { ...base };
	for (const { segment } of activeStyleSegments(segments, time)) {
		for (const group of ["background", "camera", "cursor"] as const) {
			const value = segment.overrides[group];
			if (value != null) Object.assign(result, { [group]: value });
		}
	}
	return result;
}

export function cameraOnlyPaddingAt(
	segments: readonly StyleSegment[],
	time: number,
) {
	let padding = 0;
	for (const { segment } of activeStyleSegments(segments, time)) {
		const value = segment.overrides.cameraOnlyPadding;
		if (value != null && Number.isFinite(value)) padding = value;
	}
	return Math.min(40, Math.max(0, padding));
}

export function splitOverlaySegment<T extends { start: number; end: number }>(
	segment: T,
	time: number,
	minimum = 0.05,
): [T, T] | null {
	if (
		!Number.isFinite(time) ||
		time - segment.start < minimum ||
		segment.end - time < minimum
	)
		return null;
	return [
		{ ...structuredClone(segment), end: time },
		{ ...structuredClone(segment), start: time },
	];
}

export function editOverlayInterval(
	segment: { start: number; end: number },
	delta: number,
	edge: "move" | "start" | "end",
	previousEnd: number,
	nextStart: number,
) {
	const minimum = Math.min(0.05, segment.end - segment.start);
	if (edge === "start")
		return {
			start: Math.max(
				previousEnd,
				Math.min(segment.end - minimum, segment.start + delta),
			),
			end: segment.end,
		};
	if (edge === "end")
		return {
			start: segment.start,
			end: Math.min(
				nextStart,
				Math.max(segment.start + minimum, segment.end + delta),
			),
		};
	const shift = Math.max(
		previousEnd - segment.start,
		Math.min(nextStart - segment.end, delta),
	);
	return { start: segment.start + shift, end: segment.end + shift };
}

export function stylesRevealCamera(segments: readonly StyleSegment[]) {
	return segments.some(
		(segment) =>
			segment.enabled &&
			Number.isFinite(segment.start) &&
			Number.isFinite(segment.end) &&
			segment.start >= 0 &&
			segment.end > segment.start &&
			segment.overrides.camera != null &&
			!segment.overrides.camera.hide,
	);
}
