import type { VideoMetadata } from "@cap/database/types";

export type CursorReconstruction = NonNullable<
	VideoMetadata["cursorReconstruction"]
>;
type EditorSources = NonNullable<VideoMetadata["editorSources"]>;

/** Experimental: the render farm job is slow enough to keep recordings short. */
export const CURSOR_RECONSTRUCTION_MAX_SECONDS = 5 * 60;
export const CURSOR_RECONSTRUCTION_FPS = 30;
/** A run still processing after this is abandoned and can be started again. */
export const CURSOR_RECONSTRUCTION_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_INPUT_EVENTS_BYTES = 64 * 1024 * 1024;
const RUN_ID = /^[a-z0-9]{8,32}$/;

export function cursorReconstructionPrefix(
	ownerId: string,
	videoId: string,
	runId: string,
) {
	return `${ownerId}/${videoId}/.recording/cursor/${runId}/`;
}

export function cursorReconstructionReference(videoId: string) {
	return `cursor:${videoId}`;
}

/**
 * Why a recording cannot have its cursor replaced, or null. Only browser
 * recordings qualify: their cursor is in the video and no pointer input was
 * captured with it.
 */
export function cursorReconstructionBlocker(video: {
	duration: number | null;
	metadata: VideoMetadata | null;
}) {
	const sources = video.metadata?.editorSources;
	if (!sources || sources.version !== 1) {
		return "Only browser recordings can replace their cursor";
	}
	if (sources.inputEvents) return "This recording already has cursor data";
	if (sources.display.embeddedAudio) {
		return "Imported videos cannot replace their cursor";
	}
	if (
		typeof video.duration !== "number" ||
		!Number.isFinite(video.duration) ||
		video.duration <= 0
	) {
		return "The recording is still processing";
	}
	if (video.duration > CURSOR_RECONSTRUCTION_MAX_SECONDS) {
		return "Cursor replacement is limited to recordings under 5 minutes";
	}
	return null;
}

function outputsValid(
	reconstruction: CursorReconstruction,
	ownerId: string,
	videoId: string,
) {
	if (!RUN_ID.test(reconstruction.runId)) return false;
	const prefix = cursorReconstructionPrefix(
		ownerId,
		videoId,
		reconstruction.runId,
	);
	const { display, inputEvents } = reconstruction;
	return (
		display?.key === `${prefix}display.mp4` &&
		inputEvents?.key === `${prefix}input-events.ndjson` &&
		Number.isSafeInteger(display.size) &&
		display.size > 0 &&
		display.size <= MAX_OUTPUT_BYTES &&
		Number.isSafeInteger(inputEvents.size) &&
		inputEvents.size > 0 &&
		inputEvents.size <= MAX_INPUT_EVENTS_BYTES
	);
}

/**
 * The sources the editor, its worker and farm renders use: the cleaned
 * display and reconstructed pointer input while the replacement is on and
 * was made from the current display, otherwise the recording as uploaded.
 */
export function effectiveEditorSources(
	metadata: VideoMetadata | null | undefined,
	ownerId: string,
	videoId: string,
): EditorSources | undefined {
	const sources = metadata?.editorSources;
	const reconstruction = metadata?.cursorReconstruction;
	if (
		!sources ||
		sources.version !== 1 ||
		sources.inputEvents ||
		!reconstruction ||
		reconstruction.version !== 1 ||
		!reconstruction.enabled ||
		reconstruction.status !== "ready" ||
		reconstruction.sourceKey !== sources.display.key ||
		!outputsValid(reconstruction, ownerId, videoId)
	) {
		return sources;
	}
	const { display, inputEvents } = reconstruction as Required<
		Pick<CursorReconstruction, "display" | "inputEvents">
	>;
	return {
		...sources,
		display: {
			key: display.key,
			contentType: "video/mp4",
			size: display.size,
			fps: CURSOR_RECONSTRUCTION_FPS,
			objectIdentity: null,
		},
		inputEvents: {
			key: inputEvents.key,
			contentType: "application/x-ndjson",
			size: inputEvents.size,
			objectIdentity: null,
		},
	};
}

export type CursorReconstructionView = {
	eligible: boolean;
	blocker: string | null;
	status: "idle" | "processing" | "ready" | "error";
	enabled: boolean;
	progress: number;
	error: string | null;
	/** The editor's sources carry pointer input, so it draws a cursor. */
	cursorData: boolean;
};

/** What the editor shows; a job made from an older display counts as idle. */
export function cursorReconstructionView(video: {
	id: string;
	ownerId: string;
	duration: number | null;
	metadata: VideoMetadata | null;
}): CursorReconstructionView {
	const blocker = cursorReconstructionBlocker(video);
	const reconstruction = video.metadata?.cursorReconstruction;
	const current =
		reconstruction &&
		reconstruction.sourceKey === video.metadata?.editorSources?.display.key
			? reconstruction
			: null;
	return {
		eligible: blocker === null,
		blocker,
		status: current?.status ?? "idle",
		enabled: current?.status === "ready" && current.enabled,
		progress:
			current?.status === "ready"
				? 1
				: Math.min(0.99, Math.max(0, current?.progress ?? 0)),
		error: current?.status === "error" ? (current.error ?? "Failed") : null,
		cursorData: !!effectiveEditorSources(
			video.metadata,
			video.ownerId,
			video.id,
		)?.inputEvents,
	};
}
