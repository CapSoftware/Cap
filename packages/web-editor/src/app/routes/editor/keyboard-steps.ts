export type Vec = { x: number; y: number };

export type DragPoint = { clientX: number; clientY: number; shiftKey: boolean };

export type StepKey = Pick<
	KeyboardEvent,
	"key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
>;

const ARROW_DIRECTIONS: Record<string, Vec> = {
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
};

export const DRAG_ORIGIN: Vec = { x: 0, y: 0 };

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export function arrowStep(event: StepKey, small = 1, large = 10): Vec | null {
	if (event.altKey || event.ctrlKey || event.metaKey) return null;
	const direction = ARROW_DIRECTIONS[event.key];
	if (!direction) return null;
	const size = event.shiftKey ? large : small;
	return { x: direction.x * size, y: direction.y * size };
}

// Shift is held so a keyboard step is never pulled onto a snap guide.
export function steppedDragPoint(step: Vec): DragPoint {
	return { clientX: step.x, clientY: step.y, shiftKey: true };
}

export function runSteppedDrag<T>(
	step: Vec,
	setup: () => T | null,
	update: (point: DragPoint, value: T, origin: Vec) => void,
	pauseHistory: () => () => void,
) {
	const value = setup();
	if (value === null) return false;
	const resume = pauseHistory();
	update(steppedDragPoint(step), value, DRAG_ORIGIN);
	resume();
	return true;
}

export function normalizeRotation(degrees: number) {
	return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

export function stepRotation(event: StepKey, rotation: number): number | null {
	if (event.altKey || event.ctrlKey || event.metaKey) return null;
	const size = event.shiftKey ? 15 : 1;
	const sign =
		event.key === "ArrowRight" || event.key === "ArrowDown"
			? 1
			: event.key === "ArrowLeft" || event.key === "ArrowUp"
				? -1
				: 0;
	if (sign === 0) return null;
	return normalizeRotation(rotation + sign * size);
}

export function stepPadPosition(event: StepKey, value: Vec): Vec | null {
	const step = arrowStep(event, 0.01, 0.1);
	if (!step) return null;
	return { x: clamp01(value.x + step.x), y: clamp01(value.y + step.y) };
}

export function padPositionText(value: Vec) {
	return `${Math.round(value.x * 100)}% across, ${Math.round(value.y * 100)}% down`;
}

export function stepFade(
	event: StepKey,
	edge: "in" | "out",
	value: number,
	max: number,
): number | null {
	if (event.altKey || event.ctrlKey || event.metaKey) return null;
	const size = event.shiftKey ? 1 : 0.1;
	const grow = edge === "in" ? "ArrowRight" : "ArrowLeft";
	const shrink = edge === "in" ? "ArrowLeft" : "ArrowRight";
	let next: number;
	if (event.key === grow || event.key === "ArrowUp") next = value + size;
	else if (event.key === shrink || event.key === "ArrowDown")
		next = value - size;
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = max;
	else return null;
	return Math.min(Math.max(next, 0), Math.max(0, max));
}

export function moveToolbarFocus(
	event: KeyboardEvent & { currentTarget: HTMLElement },
) {
	const delta =
		event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
	if (delta === 0) return;
	const items = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"),
	);
	if (items.length === 0) return;
	const current = items.indexOf(document.activeElement as HTMLElement);
	const next = items[(current + delta + items.length) % items.length];
	if (!next) return;
	event.preventDefault();
	next.focus();
}
