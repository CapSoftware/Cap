import { useEffect, useState } from "react";

const STORAGE_PREFIX = "cap-editor-entry-frame:";
const FRAME_WIDTH = 640;

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

function takeEntryFrame(videoId: string) {
	try {
		const key = `${STORAGE_PREFIX}${videoId}`;
		const frame = sessionStorage.getItem(key);
		sessionStorage.removeItem(key);
		return frame?.startsWith("data:image/jpeg;base64,") ? frame : null;
	} catch {
		return null;
	}
}

// Taken once: a second run of the effect, as in development, finds it
// already taken and keeps what the first run found.
export function useEntryFrame(videoId: string) {
	const [entry, setEntry] = useState<{
		videoId: string;
		frame: string | null;
	}>();
	useEffect(() => {
		const frame = takeEntryFrame(videoId);
		setEntry((current) => ({
			videoId,
			frame: frame ?? (current?.videoId === videoId ? current.frame : null),
		}));
	}, [videoId]);
	return entry?.videoId === videoId ? entry.frame : undefined;
}
