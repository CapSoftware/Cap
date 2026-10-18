/**
 * When an instant recording finishes processing, the page refresh swaps the
 * live HLS player for the final MP4 player - which restarts playback. Never
 * do that under an active viewer: defer the refresh to a natural break
 * (pause or ended), stashing the playback position so ShareVideo
 * can resume from it after the swap.
 */
export function scheduleReadyRefresh(options: {
	video: HTMLVideoElement | null;
	videoId: string;
	refresh: () => void;
}): () => void {
	const { video, videoId, refresh } = options;
	let cancelled = false;

	const stashAndRefresh = () => {
		if (cancelled) return;
		try {
			if (video && video.currentTime > 0 && !video.ended) {
				sessionStorage.setItem(
					`cap-playback-resume:${videoId}`,
					JSON.stringify({ t: video.currentTime, savedAt: Date.now() }),
				);
			}
		} catch {}
		refresh();
	};

	if (!video || video.paused || video.ended) {
		stashAndRefresh();
		return () => {};
	}

	function cleanup() {
		video?.removeEventListener("pause", onBreak);
		video?.removeEventListener("ended", onBreak);
	}
	function onBreak() {
		cleanup();
		stashAndRefresh();
		cancelled = true;
	}
	video.addEventListener("pause", onBreak);
	video.addEventListener("ended", onBreak);
	return () => {
		cancelled = true;
		cleanup();
	};
}
