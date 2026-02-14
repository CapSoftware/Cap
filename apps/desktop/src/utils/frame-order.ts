export const FRAME_ORDER_STALE_WINDOW = 30;

export function frameNumberForwardDelta(
	candidate: number,
	reference: number,
): number {
	return (candidate - reference) >>> 0;
}

export function isFrameNumberNewer(
	candidate: number,
	reference: number,
): boolean {
	const delta = frameNumberForwardDelta(candidate, reference);
	return delta !== 0 && delta < 0x80000000;
}

export function shouldDropOutOfOrderFrame(
	candidate: number,
	reference: number,
	staleWindow: number = FRAME_ORDER_STALE_WINDOW,
): boolean {
	if (candidate === reference) return true;
	if (isFrameNumberNewer(candidate, reference)) return false;
	const backwardDelta = frameNumberForwardDelta(reference, candidate);
	return backwardDelta <= staleWindow;
}
