export type WorkerInflightDispatchDecision = {
	action: "dispatch" | "backpressure";
	nextWorkerFramesInFlight: number;
	backpressureHitsIncrement: number;
	supersededDropsIncrement: number;
};

export function decideWorkerInflightDispatch(
	workerFramesInFlight: number,
	limit: number,
	hasQueuedNextFrame: boolean,
): WorkerInflightDispatchDecision {
	if (workerFramesInFlight >= limit) {
		return {
			action: "backpressure",
			nextWorkerFramesInFlight: workerFramesInFlight,
			backpressureHitsIncrement: 1,
			supersededDropsIncrement: hasQueuedNextFrame ? 1 : 0,
		};
	}

	return {
		action: "dispatch",
		nextWorkerFramesInFlight: workerFramesInFlight + 1,
		backpressureHitsIncrement: 0,
		supersededDropsIncrement: 0,
	};
}

export function updateWorkerInflightPeaks(
	workerFramesInFlight: number,
	peakWindow: number,
	peakTotal: number,
) {
	return {
		peakWindow: Math.max(peakWindow, workerFramesInFlight),
		peakTotal: Math.max(peakTotal, workerFramesInFlight),
	};
}
