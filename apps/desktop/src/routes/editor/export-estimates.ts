function formatRange(range: number[], scale: number, unit: string): string {
	const precision = scale === 1 ? 1 : 10;
	const lower = Math.max(
		1 / precision,
		Math.round((range[0] / scale) * precision) / precision,
	);
	const upper = Math.max(
		lower,
		Math.round((range[1] / scale) * precision) / precision,
	);
	return lower === upper ? `~${lower} ${unit}` : `~${lower}–${upper} ${unit}`;
}

export function formatEstimatedSize(range: number[]): string {
	if (range[1] < 1) return "< 1 MB";
	return range[1] >= 1024
		? formatRange(range, 1024, "GB")
		: formatRange(range, 1, "MB");
}

export function formatEstimatedTime(range: number[]): string {
	if (range[1] < 1) return "< 1s";
	if (range[1] >= 3600) return formatRange(range, 3600, "hr");
	if (range[1] >= 60) return formatRange(range, 60, "min");
	return formatRange(range, 1, "s");
}
