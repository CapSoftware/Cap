(() => {
	const video = document.getElementById("video");
	const params = new URLSearchParams(location.search);
	const steadyFrames = Number(params.get("steady") || 45);
	const recent = [];
	let callbacks = 0;
	let readySet = false;

	function wallclock(ms) {
		return Math.round((performance.timeOrigin + ms) * 1000) / 1000;
	}

	function onFrame(_now, meta) {
		callbacks += 1;
		const rec = {
			media_time: Math.round(meta.mediaTime * 1e6) / 1e6,
			presented_frames: meta.presentedFrames,
			expected_display: wallclock(meta.expectedDisplayTime),
			presentation: wallclock(meta.presentationTime),
		};
		recent.push(rec);
		if (recent.length > 120) recent.shift();
		cap.event("video_frame", rec);
		if (!readySet && callbacks >= steadyFrames) {
			readySet = true;
			capSetReady();
		}
		video.requestVideoFrameCallback(onFrame);
	}

	video.addEventListener("error", () => {
		cap.event("video_error", {
			code: video.error?.code,
			message: video.error?.message,
		});
	});
	for (const type of ["playing", "waiting", "stalled", "seeked"]) {
		video.addEventListener(type, () =>
			cap.event(`video_${type}`, { current_time: video.currentTime }),
		);
	}

	window.capStats = () => {
		const q = video.getVideoPlaybackQuality();
		return {
			current_time: video.currentTime,
			paused: video.paused,
			total_video_frames: q.totalVideoFrames,
			dropped_video_frames: q.droppedVideoFrames,
			frame_callbacks: callbacks,
			video_width: video.videoWidth,
			video_height: video.videoHeight,
		};
	};
	window.capRecentFrames = (n) => recent.slice(-n);
	window.capRestart = () => {
		readySet = false;
		callbacks = 0;
		recent.length = 0;
		window.capReady = false;
		video.currentTime = 0;
		video
			.play()
			.catch((e) => cap.event("video_play_error", { message: String(e) }));
	};
	window.capTextRegions = () => [];

	video.requestVideoFrameCallback(onFrame);
	const src = window.capVideoSrc;
	if (typeof src === "string") video.src = src;
	video
		.play()
		.catch((e) => cap.event("video_play_error", { message: String(e) }));
})();
