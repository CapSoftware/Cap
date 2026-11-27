import type { FrameLayoutEvent } from "./types";

function bounds(
	values: ArrayLike<number>,
	offset: number,
): [number, number, number, number] | null {
	const result: [number, number, number, number] = [
		values[offset] ?? Number.NaN,
		values[offset + 1] ?? Number.NaN,
		values[offset + 2] ?? Number.NaN,
		values[offset + 3] ?? Number.NaN,
	];
	return result.every(Number.isFinite) ? result : null;
}

export function browserFrameLayout(
	values: ArrayLike<number>,
): FrameLayoutEvent {
	const display = bounds(values, 0);
	const outputWidth = values[8] ?? 0;
	const outputHeight = values[9] ?? 0;
	if (
		!display ||
		!Number.isSafeInteger(outputWidth) ||
		!Number.isSafeInteger(outputHeight) ||
		outputWidth < 1 ||
		outputHeight < 1
	) {
		throw new Error("Editor layer layout is unavailable");
	}
	return {
		display,
		camera: bounds(values, 4),
		output_width: outputWidth,
		output_height: outputHeight,
	};
}
