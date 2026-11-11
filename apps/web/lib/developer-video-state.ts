import type {
	DeveloperVideoPart,
	DeveloperVideoPartState,
	DeveloperVideoProcessingState,
	DeveloperVideoStatus,
} from "@cap/database/types";

export const DEVELOPER_VIDEO_PARTS = ["hls", "mp4"] as const;
export const DEVELOPER_VIDEO_MAX_PART_ATTEMPTS = 2;

const MAX_REASON_LENGTH = 500;
const NEVER_STARTED_GRACE_MS = 2 * 60 * 1000;
const STALE_PROCESSING_MS = 6 * 60 * 60 * 1000;
const HLS_RETRY_BASE_MS = 15 * 60 * 1000;
const HLS_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const UNCONFIRMED_START_MS = 2 * 60 * 1000;

export type DeveloperVideoPartOutcome =
	| { type: "complete"; bytes: number; posterBytes?: number }
	| { type: "failed"; reason: string }
	| { type: "unavailable"; reason: string; now: number };

export type DeveloperVideoRedrive = "start" | "retry-hls";

export function developerVideoFailureReason(reason: string): string {
	return reason.replace(/https?:\/\/\S+/g, "[url]").slice(0, MAX_REASON_LENGTH);
}

export function createDeveloperVideoProcessingState(input: {
	encodeId: string;
	now: number;
}): DeveloperVideoProcessingState {
	return {
		encodeId: input.encodeId,
		startedAt: input.now,
		probe: null,
		hls: { state: "pending" },
		mp4: { state: "pending" },
		attempts: { hls: 0, mp4: 0 },
		poster: null,
		bytes: { source: 0, hls: 0, mp4: 0 },
	};
}

export function hlsRetryDelayMs(attempts: number): number {
	return Math.min(
		HLS_RETRY_MAX_MS,
		HLS_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
	);
}

export type DeveloperVideoPartAction = "dispatch" | "wait" | "done";

export function developerVideoPartAction(
	part: DeveloperVideoPartState,
	now: number,
): DeveloperVideoPartAction {
	if (part.state === "pending") return "dispatch";
	if (part.state !== "running") return "done";
	return part.jobId === null && now - part.startedAt >= UNCONFIRMED_START_MS
		? "dispatch"
		: "wait";
}

export function beginPart(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	input: { token: string; now: number },
): DeveloperVideoProcessingState | null {
	const current = state[part];
	if (developerVideoPartAction(current, input.now) !== "dispatch") return null;
	return {
		...state,
		[part]: {
			state: "running",
			token: input.token,
			jobId: null,
			startedAt: input.now,
		},
		attempts:
			current.state === "pending"
				? { ...state.attempts, [part]: state.attempts[part] + 1 }
				: state.attempts,
	};
}

function runningWithToken(
	part: DeveloperVideoPartState,
	token: string,
): part is Extract<DeveloperVideoPartState, { state: "running" }> {
	return part.state === "running" && part.token === token;
}

export function markPartDispatched(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	input: { token: string; jobId: string },
): DeveloperVideoProcessingState | null {
	const current = state[part];
	if (!runningWithToken(current, input.token)) return null;
	return { ...state, [part]: { ...current, jobId: input.jobId } };
}

export function releasePart(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
): DeveloperVideoProcessingState | null {
	if (!runningWithToken(state[part], token)) return null;
	return {
		...state,
		[part]: { state: "pending" },
		attempts: {
			...state.attempts,
			[part]: Math.max(0, state.attempts[part] - 1),
		},
	};
}

export function settlePart(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
	outcome: DeveloperVideoPartOutcome,
): DeveloperVideoProcessingState | null {
	if (!runningWithToken(state[part], token)) return null;
	if (outcome.type === "complete") {
		return {
			...state,
			[part]: { state: "complete", output: token },
			poster:
				state.poster ??
				(outcome.posterBytes
					? { output: token, bytes: outcome.posterBytes }
					: null),
			bytes: { ...state.bytes, [part]: outcome.bytes },
		};
	}
	if (outcome.type === "unavailable") {
		return {
			...state,
			[part]: {
				state: "unavailable",
				reason: developerVideoFailureReason(outcome.reason),
				retryAt: outcome.now + hlsRetryDelayMs(state.attempts[part]),
			},
		};
	}
	return {
		...state,
		[part]:
			state.attempts[part] < DEVELOPER_VIDEO_MAX_PART_ATTEMPTS
				? { state: "pending" }
				: {
						state: "failed",
						reason: developerVideoFailureReason(outcome.reason),
					},
	};
}

export function failUnfinishedParts(
	state: DeveloperVideoProcessingState,
	reason: string,
): DeveloperVideoProcessingState {
	const next = { ...state };
	for (const part of DEVELOPER_VIDEO_PARTS) {
		const current = state[part];
		if (current.state === "pending" || current.state === "running") {
			next[part] = {
				state: "failed",
				reason: developerVideoFailureReason(reason),
			};
		}
	}
	return next;
}

export function retryUnavailableHls(
	state: DeveloperVideoProcessingState,
): DeveloperVideoProcessingState | null {
	if (state.hls.state !== "unavailable") return null;
	return { ...state, hls: { state: "pending" } };
}

export function resolveDeveloperVideoStatus(
	state: DeveloperVideoProcessingState,
	previous: DeveloperVideoStatus,
): { status: DeveloperVideoStatus; errorReason: string | null } {
	if (previous === "ready") return { status: "ready", errorReason: null };
	const parts = DEVELOPER_VIDEO_PARTS.map((part) => state[part]);
	if (
		parts.some((part) => part.state === "pending" || part.state === "running")
	) {
		return { status: "processing", errorReason: null };
	}
	if (parts.some((part) => part.state === "complete")) {
		return { status: "ready", errorReason: null };
	}
	const failure =
		[state.mp4, state.hls].find((part) => part.state === "failed") ??
		[state.mp4, state.hls].find((part) => part.state === "unavailable");
	return {
		status: "errored",
		errorReason:
			failure && "reason" in failure
				? failure.reason
				: "Video processing failed",
	};
}

export function developerVideoStoredBytes(
	state: DeveloperVideoProcessingState,
): number {
	const { source, hls, mp4 } = state.bytes;
	return source + hls + mp4 + (state.poster?.bytes ?? 0);
}

export function developerVideoRedrive(
	video: {
		status: DeveloperVideoStatus;
		duration: number | null;
		deletedAt: Date | null;
		updatedAt: Date;
		processing: DeveloperVideoProcessingState | null;
	},
	now: number,
	options: { uploadCompleted?: boolean } = {},
): DeveloperVideoRedrive | null {
	if (video.deletedAt) return null;
	if (video.status === "uploading") {
		if (options.uploadCompleted) return "start";
		return video.duration !== null &&
			now - video.updatedAt.getTime() >= NEVER_STARTED_GRACE_MS
			? "start"
			: null;
	}
	if (video.status === "processing") {
		return !video.processing ||
			now - video.processing.startedAt >= STALE_PROCESSING_MS
			? "start"
			: null;
	}
	if (video.status === "ready") {
		const hls = video.processing?.hls;
		return hls?.state === "unavailable" && hls.retryAt <= now
			? "retry-hls"
			: null;
	}
	return null;
}
