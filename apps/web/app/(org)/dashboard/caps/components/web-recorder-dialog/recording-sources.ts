export const CAMERA_ONLY_PROMPT_DISMISSED_KEY =
	"cap-web-recorder-camera-only-prompt-dismissed";

/** What someone chose when they turned the camera-only question off. */
export type CameraOnlyChoice = "camera" | "screen";

export function parseCameraOnlyChoice(
	value: string | null,
): CameraOnlyChoice | null {
	return value === "camera" || value === "screen" ? value : null;
}

export type StartChoice =
	| "record"
	| "share-then-record"
	| "confirm-camera-only";

/**
 * What Start Recording does with the sources switched on. Nothing shared and
 * no camera goes straight to the browser's screen picker; a camera on its own
 * first asks whether the screen should be in it too, unless the browser can't
 * record a screen at all or the question was turned off, in which case the
 * answer given then is repeated.
 */
export function startRecordingChoice({
	screenShared,
	cameraEnabled,
	screenSupported,
	cameraOnlyChoice,
}: {
	screenShared: boolean;
	cameraEnabled: boolean;
	screenSupported: boolean;
	cameraOnlyChoice: CameraOnlyChoice | null;
}): StartChoice {
	if (screenShared || !screenSupported) return "record";
	if (!cameraEnabled || cameraOnlyChoice === "screen")
		return "share-then-record";
	return cameraOnlyChoice === "camera" ? "record" : "confirm-camera-only";
}

/** Recording just the microphone is offered when nothing visual is on. */
export function canRecordMicOnly({
	screenShared,
	cameraEnabled,
	micEnabled,
	idle,
}: {
	screenShared: boolean;
	cameraEnabled: boolean;
	micEnabled: boolean;
	idle: boolean;
}) {
	return idle && micEnabled && !screenShared && !cameraEnabled;
}

const MIC_ONLY_MIME_TYPES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
	"audio/ogg;codecs=opus",
];

export function micOnlyMimeType(
	isTypeSupported: (mimeType: string) => boolean,
) {
	return MIC_ONLY_MIME_TYPES.find((mimeType) => {
		try {
			return isTypeSupported(mimeType);
		} catch {
			return false;
		}
	});
}

export function micOnlyFileExtension(mimeType: string) {
	if (mimeType.startsWith("audio/mp4")) return "m4a";
	if (mimeType.startsWith("audio/ogg")) return "ogg";
	return "webm";
}

/**
 * Where a finished microphone recording opens: the editor, which shows it as
 * a waveform, for people with the web editor, and its share page otherwise.
 */
export function micOnlyLanding(videoId: string, editorEnabled: boolean) {
	const path = `/s/${encodeURIComponent(videoId)}`;
	return editorEnabled ? `${path}/edit?from=import` : path;
}
