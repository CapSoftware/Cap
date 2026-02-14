export type StrideCorrectionDispatchDecision = {
	action: "dispatch" | "queue";
	nextInFlight: boolean;
	nextHasPending: boolean;
	supersededDropsIncrement: number;
	dispatchesIncrement: number;
};

export function decideStrideCorrectionDispatch(
	inFlight: boolean,
	hasPending: boolean,
): StrideCorrectionDispatchDecision {
	if (!inFlight) {
		return {
			action: "dispatch",
			nextInFlight: true,
			nextHasPending: hasPending,
			supersededDropsIncrement: 0,
			dispatchesIncrement: 1,
		};
	}

	return {
		action: "queue",
		nextInFlight: true,
		nextHasPending: true,
		supersededDropsIncrement: hasPending ? 1 : 0,
		dispatchesIncrement: 0,
	};
}
