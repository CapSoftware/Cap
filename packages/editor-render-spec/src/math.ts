export function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export function toEven(value: number): number {
	const rounded = Math.round(value);
	const even = rounded % 2 === 0 ? rounded : rounded + 1;
	return Math.max(2, even);
}

export function normalizeChannel(value: number): number {
	return Math.round(clamp(value, 0, 255));
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
