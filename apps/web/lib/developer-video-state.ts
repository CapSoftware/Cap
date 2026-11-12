import type {
	DeveloperVideoPart,
	DeveloperVideoPartState,
	DeveloperVideoProcessingState,
	DeveloperVideoStatus,
} from "@cap/database/types";

// The MP4 comes first: it is the quicker output, so it is sent to the encoder first.
export const DEVELOPER_VIDEO_PARTS = ["mp4", "hls"] as const;
export const DEVELOPER_VIDEO_MAX_PART_ATTEMPTS = 2;
export const DEVELOPER_VIDEO_MAX_LOST_JOBS = 3;

const MAX_REASON_LENGTH = 500;
const NEVER_STARTED_GRACE_MS = 2 * 60 * 1000;
const STALE_PROCESSING_MS = 6 * 60 * 60 * 1000;
const HLS_RETRY_BASE_MS = 15 * 60 * 1000;
const HLS_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const UNCONFIRMED_START_MS = 2 * 60 * 1000;
// The media server marks a live job every 60 seconds and offers an undelivered
// result again on the same beat, but an adaptive streaming job sends nothing
// while it encodes. Silence alone cannot tell a slow encode from a lost one,
// so after three beats the job is asked about instead.
export const SILENT_JOB_CHECK_MS = 3 * 60 * 1000;
// The status route answers "not found" both when no instance has the job and
// when the instance running it was slow to answer its peer, so one answer is
// not proof. A job counts as lost once it has stayed not found for a minute,
// with no answer in between saying it is alive.
export const LOST_JOB_CONFIRM_MS = 60 * 1000;

export type DeveloperVideoPartOutcome =
	| {
			type: "complete";
			bytes: number;
			posterBytes?: number;
			duration?: number;
	  }
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
		unavailableChecks: 0,
		poster: null,
		bytes: { source: 0, hls: 0, mp4: 0, poster: 0 },
	};
}

export function hlsRetryDelayMs(attempts: number): number {
	return Math.min(
		HLS_RETRY_MAX_MS,
		HLS_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
	);
}

export type DeveloperVideoPartAction = "dispatch" | "wait" | "check" | "done";

export function developerVideoPartAction(
	part: DeveloperVideoPartState,
	now: number,
): DeveloperVideoPartAction {
	if (part.state === "pending") return "dispatch";
	if (part.state !== "running") return "done";
	if (part.jobId === null) {
		return now - part.startedAt >= UNCONFIRMED_START_MS ? "dispatch" : "wait";
	}
	return now - (part.checkedAt ?? part.startedAt) >= SILENT_JOB_CHECK_MS
		? "check"
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

export function markPartChecked(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	input: { token: string; now: number },
): DeveloperVideoProcessingState | null {
	const current = state[part];
	if (!runningWithToken(current, input.token)) return null;
	const { notFoundAt: _notFoundAt, ...alive } = current;
	return { ...state, [part]: { ...alive, checkedAt: input.now } };
}

export function markPartNotFound(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	input: { token: string; now: number },
): DeveloperVideoProcessingState | null {
	const current = state[part];
	if (
		!runningWithToken(current, input.token) ||
		current.notFoundAt !== undefined
	) {
		return null;
	}
	return { ...state, [part]: { ...current, notFoundAt: input.now } };
}

export function lostJobConfirmed(
	part: DeveloperVideoPartState,
	now: number,
): boolean {
	return (
		part.state === "running" &&
		part.notFoundAt !== undefined &&
		now - part.notFoundAt >= LOST_JOB_CONFIRM_MS
	);
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

// A job that ended because its server stopped says nothing about the file, so
// the part is sent again without costing an attempt. The count is capped so a
// file that takes the encoder down each time, or a status answer that is
// wrong, cannot keep restarting the same encode.
export function requeueLostPart(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
): DeveloperVideoProcessingState | null {
	const lost = state.lostJobs?.[part] ?? 0;
	if (lost >= DEVELOPER_VIDEO_MAX_LOST_JOBS) return null;
	const released = releasePart(state, part, token);
	return (
		released && {
			...released,
			lostJobs: { ...state.lostJobs, [part]: lost + 1 },
		}
	);
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
			probe:
				state.probe && state.probe.duration === null && outcome.duration
					? { ...state.probe, duration: outcome.duration }
					: state.probe,
			poster: state.poster ?? (outcome.posterBytes ? { output: token } : null),
			bytes: {
				...state.bytes,
				[part]: outcome.bytes,
				poster: state.bytes.poster + (outcome.posterBytes ?? 0),
			},
		};
	}
	if (outcome.type === "unavailable") {
		const checks = state.unavailableChecks + 1;
		return {
			...state,
			[part]: {
				state: "unavailable",
				reason: developerVideoFailureReason(outcome.reason),
				retryAt: outcome.now + hlsRetryDelayMs(checks),
			},
			attempts: {
				...state.attempts,
				[part]: Math.max(0, state.attempts[part] - 1),
			},
			unavailableChecks: checks,
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

function partWasLost(
	part: DeveloperVideoPartState,
	now: number,
	lastStarted: number,
): boolean {
	if (part.state === "running") {
		return now - part.startedAt >= STALE_PROCESSING_MS;
	}
	return (
		part.state === "pending" && now - lastStarted >= NEVER_STARTED_GRACE_MS
	);
}

// A ready video keeps playing from the output it has while the other one is
// retried: adaptive streaming the media server could not make earlier, or a
// job that stopped reporting. developerVideoRedrive decides when that is due.
export function retryUnavailableHls(
	state: DeveloperVideoProcessingState,
	now: number = Date.now(),
): DeveloperVideoProcessingState | null {
	let next = state;
	if (state.hls.state === "unavailable") {
		next = { ...next, hls: { state: "pending" } };
	}
	for (const part of DEVELOPER_VIDEO_PARTS) {
		const current = next[part];
		if (
			current.state === "running" &&
			now - current.startedAt >= STALE_PROCESSING_MS
		) {
			next = { ...next, [part]: { state: "pending" } };
		}
	}
	const states = DEVELOPER_VIDEO_PARTS.map((part) => state[part].state);
	const waiting = states.includes("complete") && states.includes("pending");
	if (next === state && !waiting) return null;
	// Stamping the retry is what stops the next read from claiming it again
	// before the workflow has picked the part up.
	return { ...next, startedAt: now };
}

export function resolveDeveloperVideoStatus(
	state: DeveloperVideoProcessingState,
	previous: DeveloperVideoStatus,
): { status: DeveloperVideoStatus; errorReason: string | null } {
	if (previous === "ready") return { status: "ready", errorReason: null };
	const parts = DEVELOPER_VIDEO_PARTS.map((part) => state[part]);
	if (parts.some((part) => part.state === "complete")) {
		return { status: "ready", errorReason: null };
	}
	if (
		parts.some((part) => part.state === "pending" || part.state === "running")
	) {
		return { status: "processing", errorReason: null };
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
	const { source, hls, mp4, poster } = state.bytes;
	return source + hls + mp4 + poster;
}

export function developerVideoRedrive(
	video: {
		status: DeveloperVideoStatus;
		playbackId: string | null;
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
		// Uploaded before encoding existed: it stays as it was rather than
		// being re-encoded the first time someone reads it.
		if (video.playbackId === null && video.processing === null) return null;
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
	if (video.status === "ready" && video.processing) {
		const { hls, mp4 } = video.processing;
		if (hls.state === "unavailable" && hls.retryAt <= now) return "retry-hls";
		const lastStarted = Math.max(
			video.updatedAt.getTime(),
			video.processing.startedAt,
		);
		return [mp4, hls].some((part) => partWasLost(part, now, lastStarted))
			? "retry-hls"
			: null;
	}
	return null;
}
