import type { VideoTimelineState } from "@/lib/video-edits";
import { normalizeTimelineState } from "@/lib/video-edits";

export type TimelineDraftStorage = Pick<
	Storage,
	"getItem" | "removeItem" | "setItem"
>;

const TIMELINE_DRAFT_VERSION = 1;

type StoredTimelineDraft = {
	version: typeof TIMELINE_DRAFT_VERSION;
	duration: number;
	state: VideoTimelineState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumberValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStoredEditRange(value: unknown) {
	return (
		isRecord(value) &&
		isFiniteNumberValue(value.start) &&
		isFiniteNumberValue(value.end)
	);
}

function isStoredTimelineState(value: unknown): value is VideoTimelineState {
	return (
		isRecord(value) &&
		isFiniteNumberValue(value.duration) &&
		isFiniteNumberValue(value.trimStart) &&
		isFiniteNumberValue(value.trimEnd) &&
		Array.isArray(value.splitPoints) &&
		value.splitPoints.every(isFiniteNumberValue) &&
		Array.isArray(value.deletedRanges) &&
		value.deletedRanges.every(isStoredEditRange) &&
		(value.selectedSegmentId === null ||
			typeof value.selectedSegmentId === "string")
	);
}

export function getTimelineDraftKey(videoId: string) {
	return `cap:edit-timeline-draft:${videoId}`;
}

export function getTimelineDraftStorage(): TimelineDraftStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function serializeTimelineDraft(
	duration: number,
	state: VideoTimelineState,
) {
	const draft: StoredTimelineDraft = {
		version: TIMELINE_DRAFT_VERSION,
		duration,
		state: normalizeTimelineState({ ...state, duration }),
	};
	return JSON.stringify(draft);
}

export function parseTimelineDraft(raw: string | null, duration: number) {
	if (!raw) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			parsed.version !== TIMELINE_DRAFT_VERSION ||
			!isFiniteNumberValue(parsed.duration) ||
			Math.abs(parsed.duration - duration) > 0.01 ||
			!isStoredTimelineState(parsed.state)
		) {
			return null;
		}
		return normalizeTimelineState({ ...parsed.state, duration });
	} catch {
		return null;
	}
}

export function readTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
	duration: number,
) {
	try {
		return parseTimelineDraft(storage.getItem(storageKey), duration);
	} catch {
		return null;
	}
}

export function writeTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
	duration: number,
	state: VideoTimelineState,
) {
	try {
		storage.setItem(storageKey, serializeTimelineDraft(duration, state));
	} catch {
		return;
	}
}

export function clearTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
) {
	try {
		storage.removeItem(storageKey);
	} catch {
		return;
	}
}
