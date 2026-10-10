export type StartChoice = "record" | "share-then-record";

/**
 * What Start Recording does with the sources switched on. A shared screen or
 * a camera records straight away (the camera on its own when no screen is
 * shared, which the button says); with neither, the browser's screen picker
 * opens first. A browser that can't record a screen records the camera.
 */
export function startRecordingChoice({
	screenShared,
	cameraEnabled,
	screenSupported,
}: {
	screenShared: boolean;
	cameraEnabled: boolean;
	screenSupported: boolean;
}): StartChoice {
	if (screenShared || cameraEnabled || !screenSupported) return "record";
	return "share-then-record";
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
