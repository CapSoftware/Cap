export type PointerDragSession = {
	cleanup: () => void;
};

export function startPointerDrag(options: {
	target: HTMLElement;
	pointerId: number;
	pauseHistory: () => () => void;
	pauseImmediately?: boolean;
	onStart?: () => void;
	onMove: (event: PointerEvent) => void;
}): PointerDragSession {
	let active = true;
	let resumeHistory: (() => void) | null = null;

	const pauseHistory = () => {
		if (!resumeHistory) resumeHistory = options.pauseHistory();
	};
	const move = (event: PointerEvent) => {
		if (event.pointerId !== options.pointerId) return;
		pauseHistory();
		options.onMove(event);
	};
	const cleanup = () => {
		if (!active) return;
		active = false;
		options.target.removeEventListener("pointermove", move);
		options.target.removeEventListener("pointerup", end);
		options.target.removeEventListener("pointercancel", end);
		options.target.removeEventListener("lostpointercapture", end);
		resumeHistory?.();
		resumeHistory = null;
	};
	const end = (event: PointerEvent) => {
		if (event.pointerId === options.pointerId) cleanup();
	};

	options.target.addEventListener("pointermove", move);
	options.target.addEventListener("pointerup", end);
	options.target.addEventListener("pointercancel", end);
	options.target.addEventListener("lostpointercapture", end);
	try {
		options.target.setPointerCapture(options.pointerId);
		if (options.pauseImmediately) pauseHistory();
		options.onStart?.();
	} catch (error) {
		cleanup();
		throw error;
	}

	return { cleanup };
}
