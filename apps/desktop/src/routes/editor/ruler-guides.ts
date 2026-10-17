import { createSignal } from "solid-js";

export const RULER_THICKNESS = 18;
const GUIDES_STORAGE_KEY = "cap.preview.guides";

// Positions are normalized [0, 1] against the output frame. "v" guides are
// vertical lines (an x position), "h" guides horizontal ones (a y position).
export type Guides = { v: number[]; h: number[] };
export type GuideAxis = keyof Guides;

const isGuides = (value: unknown): value is Guides =>
	typeof value === "object" &&
	value !== null &&
	Array.isArray((value as Guides).v) &&
	Array.isArray((value as Guides).h);

const readGuides = (): Guides => {
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(GUIDES_STORAGE_KEY) ?? "null",
		);
		return isGuides(parsed) ? parsed : { v: [], h: [] };
	} catch {
		return { v: [], h: [] };
	}
};

const [guides, setGuidesSignal] = createSignal<Guides>(readGuides());

export { guides };

export function setGuides(next: Guides) {
	setGuidesSignal(next);
	try {
		localStorage.setItem(GUIDES_STORAGE_KEY, JSON.stringify(next));
	} catch {}
}

export function isGuideDiscarded(position: number, frameLength: number) {
	return (
		!Number.isFinite(position) ||
		position < 0 ||
		position > 1 ||
		position * frameLength < RULER_THICKNESS
	);
}

export function withGuide(
	current: Guides,
	axis: GuideAxis,
	index: number | null,
	position: number | null,
): Guides {
	const list = [...current[axis]];
	if (index === null) {
		if (position !== null) list.push(position);
	} else if (position === null) {
		list.splice(index, 1);
	} else {
		list[index] = position;
	}
	return { ...current, [axis]: list };
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;

	it("adds, moves and removes guides", () => {
		let state: Guides = { v: [], h: [] };
		state = withGuide(state, "h", null, 0.25);
		state = withGuide(state, "h", null, 0.75);
		state = withGuide(state, "h", 0, 0.3);
		expect(state.h).toEqual([0.3, 0.75]);
		state = withGuide(state, "h", 1, null);
		expect(state.h).toEqual([0.3]);
		expect(state.v).toEqual([]);
	});

	it("discards guides dropped on the ruler or outside the frame", () => {
		expect(isGuideDiscarded(0.01, 1000)).toBe(true);
		expect(isGuideDiscarded(0.5, 1000)).toBe(false);
		expect(isGuideDiscarded(1.2, 1000)).toBe(true);
	});
}
