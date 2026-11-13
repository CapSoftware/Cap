import type {
	DeveloperVideoPart,
	DeveloperVideoPartState,
	DeveloperVideoProcessingState,
	DeveloperVideoSlice,
	DeveloperVideoSlicedHls,
	DeveloperVideoSliceResult,
	DeveloperVideoStatus,
} from "@cap/database/types";
import {
	finishedSlices,
	SLICED_HLS,
	slicedHlsBytes,
	slicedHlsPlayback,
	sliceIsFinished,
	slicesMatch,
} from "./developer-video-slices";

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
	return reconcileSlicedHls(settleRunningPart(state, part, token, outcome));
}

function settleRunningPart(
	state: DeveloperVideoProcessingState,
	part: DeveloperVideoPart,
	token: string,
	outcome: DeveloperVideoPartOutcome,
): DeveloperVideoProcessingState {
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
	const sliced = next.sliced;
	return reconcileSlicedHls(
		sliced?.state === "encoding"
			? {
					...next,
					sliced: {
						...sliced,
						state: "abandoned",
						reason: developerVideoFailureReason(reason),
					},
				}
			: next,
	);
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
	const sliced = slicedHlsEncoding(next);
	if (sliced) {
		const slices = sliced.slices.map((slice) =>
			slice.job.state === "running" &&
			now - slice.job.startedAt >= STALE_PROCESSING_MS
				? { ...slice, job: { state: "pending" as const } }
				: slice,
		);
		if (slices.some((slice, index) => slice !== sliced.slices[index])) {
			next = { ...next, sliced: { ...sliced, slices } };
		}
	}
	const states = DEVELOPER_VIDEO_PARTS.map((part) => state[part].state);
	const waiting =
		states.includes("pending") &&
		(states.includes("complete") ||
			(sliced !== null && finishedSlices(sliced).length > 0));
	if (next === state && !waiting) return null;
	// Stamping the retry is what stops the next read from claiming it again
	// before the workflow has picked the part up.
	return { ...next, startedAt: now };
}

export function resolveDeveloperVideoStatus(
	state: DeveloperVideoProcessingState,
	previous: DeveloperVideoStatus,
): { status: DeveloperVideoStatus; errorReason: string | null } {
	const parts = DEVELOPER_VIDEO_PARTS.map((part) => state[part]);
	const playable =
		parts.some((part) => part.state === "complete") ||
		slicedHlsPlayback(state) !== null;
	const unfinished = parts.some(
		(part) => part.state === "pending" || part.state === "running",
	);
	// A ready video stays ready. The one exception is a video that became ready
	// on its first slices alone: if the rest could not be made, by slices or as
	// one job, and there is no MP4 either, what it has is not the whole video.
	if (previous === "ready" && (!state.sliced || playable || unfinished)) {
		return { status: "ready", errorReason: null };
	}
	if (playable) return { status: "ready", errorReason: null };
	if (unfinished) return { status: "processing", errorReason: null };
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
		const sliced = slicedHlsEncoding(video.processing);
		if (sliced) {
			return partWasLost(mp4, now, lastStarted) ||
				slicesWereLost(sliced, now, lastStarted)
				? "retry-hls"
				: null;
		}
		return [mp4, hls].some((part) => partWasLost(part, now, lastStarted))
			? "retry-hls"
			: null;
	}
	return null;
}

// Slices are encoded while the hls part waits. Once that part is complete,
// the single job owns adaptive streaming.
export function slicedHlsEncoding(
	state: DeveloperVideoProcessingState,
): DeveloperVideoSlicedHls | null {
	return state.sliced?.state === "encoding" && state.hls.state !== "complete"
		? state.sliced
		: null;
}

// A finished single job replaces slices that are still encoding. Slices that
// were given up stay stored, and counted, only while the single job that
// replaces them is still to come.
function reconcileSlicedHls(
	state: DeveloperVideoProcessingState,
): DeveloperVideoProcessingState {
	const { sliced, hls } = state;
	if (!sliced) return state;
	if (sliced.state === "encoding" && hls.state === "complete") {
		return {
			...state,
			sliced: {
				...sliced,
				state: "abandoned",
				reason: "Replaced by a single encode",
			},
		};
	}
	if (
		sliced.state === "abandoned" &&
		(hls.state === "failed" || hls.state === "unavailable") &&
		state.bytes.hls !== 0
	) {
		return { ...state, bytes: { ...state.bytes, hls: 0 } };
	}
	return state;
}

function slicesWereLost(
	sliced: DeveloperVideoSlicedHls,
	now: number,
	lastStarted: number,
): boolean {
	const running = sliced.slices.flatMap((slice) =>
		slice.job.state === "running" ? [slice.job] : [],
	);
	if (running.some((job) => now - job.startedAt >= STALE_PROCESSING_MS)) {
		return true;
	}
	return running.length === 0 && now - lastStarted >= NEVER_STARTED_GRACE_MS;
}

export interface SlicedHlsStep {
	dispatch: number[];
	check: number[];
	finalize: boolean;
}

// What the slices need next: the earliest ones not yet sent, up to the number
// one video may have encoding at a time, the quiet jobs to ask about, and the
// final write once every slice is in.
export function slicedHlsStep(
	sliced: DeveloperVideoSlicedHls,
	now: number,
): SlicedHlsStep {
	const actions = sliced.slices.map((slice) =>
		developerVideoPartAction(slice.job, now),
	);
	const inFlight = sliced.slices.filter(
		(slice, index) =>
			slice.job.state === "running" && actions[index] !== "dispatch",
	).length;
	const due = actions.flatMap((action, index) =>
		action === "dispatch" ? [index] : [],
	);
	return {
		dispatch: due.slice(0, Math.max(0, SLICED_HLS.maxInFlight - inFlight)),
		check: actions.flatMap((action, index) =>
			action === "check" ? [index] : [],
		),
		finalize: sliced.slices.every((slice) => sliceIsFinished(slice)),
	};
}

export function slicedHlsAction(
	sliced: DeveloperVideoSlicedHls,
	now: number,
): DeveloperVideoPartAction {
	const step = slicedHlsStep(sliced, now);
	if (step.finalize || step.dispatch.length > 0) return "dispatch";
	return step.check.length > 0 ? "check" : "wait";
}

function withSlice(
	state: DeveloperVideoProcessingState,
	sliced: DeveloperVideoSlicedHls,
	index: number,
	slice: DeveloperVideoSlice,
): DeveloperVideoProcessingState {
	return {
		...state,
		sliced: {
			...sliced,
			slices: sliced.slices.map((current, at) =>
				at === index ? slice : current,
			),
		},
	};
}

interface RunningSlice {
	sliced: DeveloperVideoSlicedHls;
	index: number;
	slice: DeveloperVideoSlice;
	job: Extract<DeveloperVideoPartState, { state: "running" }>;
}

export function findRunningSlice(
	state: DeveloperVideoProcessingState,
	token: string,
): RunningSlice | null {
	const sliced = slicedHlsEncoding(state);
	if (!sliced) return null;
	for (const [index, slice] of sliced.slices.entries()) {
		if (runningWithToken(slice.job, token)) {
			return { sliced, index, slice, job: slice.job };
		}
	}
	return null;
}

export function beginSlices(
	state: DeveloperVideoProcessingState,
	input: { tokens: string[]; now: number },
): {
	state: DeveloperVideoProcessingState;
	begun: { index: number; token: string }[];
} | null {
	const sliced = slicedHlsEncoding(state);
	if (!sliced) return null;
	const { dispatch } = slicedHlsStep(sliced, input.now);
	const begun = dispatch.flatMap((index, at) => {
		const token = input.tokens[at];
		return token ? [{ index, token }] : [];
	});
	if (begun.length === 0) return null;
	const slices = sliced.slices.map((slice, index) => {
		const pick = begun.find((entry) => entry.index === index);
		if (!pick) return slice;
		return {
			...slice,
			job: {
				state: "running" as const,
				token: pick.token,
				jobId: null,
				startedAt: input.now,
			},
			attempts:
				slice.job.state === "pending" ? slice.attempts + 1 : slice.attempts,
		};
	});
	return { state: { ...state, sliced: { ...sliced, slices } }, begun };
}

export function markSliceDispatched(
	state: DeveloperVideoProcessingState,
	input: { token: string; jobId: string },
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, input.token);
	if (!found) return null;
	return withSlice(state, found.sliced, found.index, {
		...found.slice,
		job: { ...found.job, jobId: input.jobId },
	});
}

export function markSliceChecked(
	state: DeveloperVideoProcessingState,
	input: { token: string; now: number },
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, input.token);
	if (!found) return null;
	const { notFoundAt: _notFoundAt, ...alive } = found.job;
	return withSlice(state, found.sliced, found.index, {
		...found.slice,
		job: { ...alive, checkedAt: input.now },
	});
}

export function markSliceNotFound(
	state: DeveloperVideoProcessingState,
	input: { token: string; now: number },
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, input.token);
	if (!found || found.job.notFoundAt !== undefined) return null;
	return withSlice(state, found.sliced, found.index, {
		...found.slice,
		job: { ...found.job, notFoundAt: input.now },
	});
}

export function releaseSlice(
	state: DeveloperVideoProcessingState,
	token: string,
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, token);
	if (!found) return null;
	return withSlice(state, found.sliced, found.index, {
		...found.slice,
		job: { state: "pending" },
		attempts: Math.max(0, found.slice.attempts - 1),
	});
}

// Gives up on slices and leaves adaptive streaming to one job for the whole
// video, which gets a single attempt. The finished slices stay where they
// are, so a video that is already playing from them keeps playing until that
// job has an answer.
export function abandonSlicedHls(
	state: DeveloperVideoProcessingState,
	reason: string,
): DeveloperVideoProcessingState {
	const { sliced } = state;
	if (!sliced || sliced.state !== "encoding") return state;
	return reconcileSlicedHls({
		...state,
		sliced: {
			...sliced,
			state: "abandoned",
			reason: developerVideoFailureReason(reason),
		},
		attempts:
			state.hls.state === "pending"
				? { ...state.attempts, hls: DEVELOPER_VIDEO_MAX_PART_ATTEMPTS - 1 }
				: state.attempts,
	});
}

const LOST_SLICE = "A slice of the video kept losing its encode job";

// A slice whose job ended with its server is sent again without costing an
// attempt. One that keeps vanishing is treated as a slice that cannot be made.
export function requeueLostSlice(
	state: DeveloperVideoProcessingState,
	token: string,
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, token);
	if (!found) return null;
	if (found.slice.lostJobs >= DEVELOPER_VIDEO_MAX_LOST_JOBS) {
		return abandonSlicedHls(
			withSlice(state, found.sliced, found.index, {
				...found.slice,
				job: { state: "failed", reason: LOST_SLICE },
			}),
			LOST_SLICE,
		);
	}
	return withSlice(state, found.sliced, found.index, {
		...found.slice,
		job: { state: "pending" },
		attempts: Math.max(0, found.slice.attempts - 1),
		lostJobs: found.slice.lostJobs + 1,
	});
}

export type DeveloperVideoSliceOutcome =
	| {
			type: "complete";
			result: DeveloperVideoSliceResult;
			posterBytes?: number;
	  }
	| { type: "failed"; reason: string };

const MISMATCHED_SLICES = "Slices were encoded with different renditions";

export function settleSlice(
	state: DeveloperVideoProcessingState,
	token: string,
	outcome: DeveloperVideoSliceOutcome,
): DeveloperVideoProcessingState | null {
	const found = findRunningSlice(state, token);
	if (!found) return null;
	const { sliced, index, slice } = found;
	const other = finishedSlices(sliced)[0]?.slice;
	const failure =
		outcome.type === "failed"
			? outcome.reason
			: other &&
					!slicesMatch(other.result.renditions, outcome.result.renditions)
				? MISMATCHED_SLICES
				: null;
	if (outcome.type === "failed" || failure !== null) {
		const reason = developerVideoFailureReason(failure ?? MISMATCHED_SLICES);
		if (slice.attempts < DEVELOPER_VIDEO_MAX_PART_ATTEMPTS) {
			return withSlice(state, sliced, index, {
				...slice,
				job: { state: "pending" },
			});
		}
		return abandonSlicedHls(
			withSlice(state, sliced, index, {
				...slice,
				job: { state: "failed", reason },
			}),
			reason,
		);
	}

	const slices = sliced.slices.map((current, at) =>
		at === index
			? {
					...slice,
					job: { state: "complete" as const, output: token },
					result: outcome.result,
				}
			: current,
	);
	const first = index === 0;
	const next: DeveloperVideoSlicedHls = {
		...sliced,
		slices,
		hasAudio: first ? outcome.result.audioBytes > 0 : sliced.hasAudio,
		// Decided once, when the start of the video is first in: a video that
		// already plays from its MP4 gets its adaptive stream when it is whole.
		exposed:
			sliced.exposed === null && sliceIsFinished(slices[0])
				? state.mp4.state !== "complete"
				: sliced.exposed,
	};
	const posterBytes = first ? (outcome.posterBytes ?? 0) : 0;
	return {
		...state,
		sliced: next,
		poster: state.poster ?? (posterBytes > 0 ? { output: token } : null),
		bytes: {
			...state.bytes,
			hls: slicedHlsBytes(next),
			poster: state.bytes.poster + posterBytes,
		},
	};
}

// Every slice is in and the whole ladder has been written to the slices'
// folder, so the hls part is complete and points at it like any other ladder.
export function completeSlicedHls(
	state: DeveloperVideoProcessingState,
): DeveloperVideoProcessingState | null {
	const sliced = slicedHlsEncoding(state);
	if (!sliced || !sliced.slices.every((slice) => sliceIsFinished(slice))) {
		return null;
	}
	return {
		...state,
		hls: { state: "complete", output: sliced.output },
		sliced: { ...sliced, state: "complete" },
		bytes: { ...state.bytes, hls: slicedHlsBytes(sliced) },
	};
}
