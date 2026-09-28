const STORAGE_PREFIX = "cap-editor-entry-frame:";
const FRAME_WIDTH = 640;

/** Keeps the share page's current frame so the editor can open on it. */
export function rememberEntryFrame(
	videoId: string,
	video: HTMLVideoElement | null,
) {
	try {
		if (!video || video.videoWidth < 1) return;
		const canvas = document.createElement("canvas");
		canvas.width = Math.min(FRAME_WIDTH, video.videoWidth);
		canvas.height = Math.round(
			(canvas.width / video.videoWidth) * video.videoHeight,
		);
		canvas
			.getContext("2d")
			?.drawImage(video, 0, 0, canvas.width, canvas.height);
		sessionStorage.setItem(
			`${STORAGE_PREFIX}${videoId}`,
			canvas.toDataURL("image/jpeg", 0.8),
		);
	} catch {
		/* a cross-origin video can't be read back; the editor opens without it */
	}
}

export function readEntryFrame(videoId: string) {
	try {
		const frame = sessionStorage.getItem(`${STORAGE_PREFIX}${videoId}`);
		return frame?.startsWith("data:image/jpeg;base64,") ? frame : null;
	} catch {
		return null;
	}
}

export function forgetEntryFrame(videoId: string) {
	try {
		sessionStorage.removeItem(`${STORAGE_PREFIX}${videoId}`);
	} catch {}
}
