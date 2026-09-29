type Span = { start: number; end: number };

/** Whether each span starts at or after the previous one ends. */
export function spansInOrder(spans: readonly Span[]) {
	for (let index = 1; index < spans.length; index++) {
		const previous = spans[index - 1];
		const span = spans[index];
		if (!previous || !span || span.start < previous.end) return false;
	}
	return true;
}

/**
 * Index of the first span covering `time`, or -1. Spans known to be in order
 * are binary searched; anything else is scanned.
 */
export function spanIndexAt(
	spans: readonly Span[],
	time: number,
	inOrder: boolean,
) {
	if (!inOrder)
		return spans.findIndex((span) => time >= span.start && time < span.end);
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const span = spans[mid];
		if (!span) return -1;
		if (time < span.start) hi = mid - 1;
		else if (time >= span.end) lo = mid + 1;
		else return mid;
	}
	return -1;
}
