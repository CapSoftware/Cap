import { shouldDropOutOfOrderFrame } from "./frame-order";

export type FrameOrderDecision = {
	action: "accept" | "drop";
	nextLatestFrameNumber: number | null;
	dropsIncrement: number;
};

export function decideFrameOrder(
	candidateFrameNumber: number | null,
	latestFrameNumber: number | null,
	staleWindow: number,
): FrameOrderDecision {
	if (candidateFrameNumber === null) {
		return {
			action: "accept",
			nextLatestFrameNumber: latestFrameNumber,
			dropsIncrement: 0,
		};
	}

	if (latestFrameNumber === null) {
		return {
			action: "accept",
			nextLatestFrameNumber: candidateFrameNumber,
			dropsIncrement: 0,
		};
	}

	if (
		shouldDropOutOfOrderFrame(
			candidateFrameNumber,
			latestFrameNumber,
			staleWindow,
		)
	) {
		return {
			action: "drop",
			nextLatestFrameNumber: latestFrameNumber,
			dropsIncrement: 1,
		};
	}

	return {
		action: "accept",
		nextLatestFrameNumber: candidateFrameNumber,
		dropsIncrement: 0,
	};
}
