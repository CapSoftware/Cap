import { useEffect, useRef } from "react";

export const abandonRecording = (videoId: string) =>
	fetch("/api/upload/abandon", {
		method: "POST",
		keepalive: true,
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoId }),
	}).catch(() => undefined);

// Leaving the page mid-take ends the recording with it. The local backup is
// offered for recovery on the next visit, so the server copy that can no
// longer finish is dropped rather than left uploading.
export const useAbandonOnLeave = (getVideoId: () => string | null) => {
	const getVideoIdRef = useRef(getVideoId);
	getVideoIdRef.current = getVideoId;

	useEffect(() => {
		const handlePageHide = (event: PageTransitionEvent) => {
			if (event.persisted) return;
			const videoId = getVideoIdRef.current();
			if (videoId) void abandonRecording(videoId);
		};
		window.addEventListener("pagehide", handlePageHide);
		return () => window.removeEventListener("pagehide", handlePageHide);
	}, []);
};
