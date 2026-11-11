export interface CapPlayerSource {
	hls?: string;
	mp4?: string;
}

export type PlaybackMode = "native" | "mse" | "file" | "none";

const HLS_MIME = "application/vnd.apple.mpegurl";
const DEFAULT_BITS_PER_SECOND = 5_000_000;

type ConnectionHint = { downlink?: number };

export const pickPlaybackMode = (
	video: HTMLVideoElement,
	source: CapPlayerSource,
): PlaybackMode => {
	if (source.hls) {
		const native = video.canPlayType(HLS_MIME) !== "";
		const mse = "ManagedMediaSource" in window || "MediaSource" in window;
		const apple = navigator.vendor.includes("Apple");
		if (native && (apple || !mse)) return "native";
		if (mse) return "mse";
	}
	return source.mp4 ? "file" : "none";
};

let hlsModule: Promise<typeof import("hls.js")> | undefined;

const loadHls = () => {
	hlsModule ??= import("hls.js");
	return hlsModule;
};

export const warmSource = (source: CapPlayerSource) => {
	const mode = pickPlaybackMode(document.createElement("video"), source);
	if (mode === "mse") void loadHls().catch(() => undefined);
};

const startingEstimate = () => {
	const connection = (navigator as Navigator & { connection?: ConnectionHint })
		.connection;
	const megabits = connection?.downlink;
	return megabits && megabits > 0
		? megabits * 800_000
		: DEFAULT_BITS_PER_SECOND;
};

export const pickStartingLevel = (
	levels: readonly { bitrate: number; width: number }[],
	wantedWidth: number,
	bitsPerSecond: number,
) => {
	let pick = 0;
	for (let i = 1; i < levels.length; i++) {
		const level = levels[i];
		const below = levels[i - 1];
		if (!level || !below) break;
		if (level.bitrate > bitsPerSecond || below.width >= wantedWidth) break;
		pick = i;
	}
	return pick;
};

const release = (video: HTMLVideoElement) => {
	video.removeAttribute("src");
	video.load();
};

export const attachSource = (
	video: HTMLVideoElement,
	source: CapPlayerSource,
	options: { autoPlay: boolean; onFatal: () => void },
): (() => void) => {
	const { autoPlay, onFatal } = options;
	const mode = pickPlaybackMode(video, source);
	let cancelled = false;
	let detach = () => release(video);

	const start = () => {
		if (autoPlay) void video.play().catch(() => undefined);
	};

	const position = () => ({
		resumeAt: video.currentTime,
		wasPlaying: !video.paused,
	});

	let fileAttached = false;

	function onNativeError() {
		playFile();
	}

	function playFile({ resumeAt, wasPlaying } = position()) {
		if (cancelled) return;
		if (!source.mp4 || fileAttached) {
			onFatal();
			return;
		}
		fileAttached = true;
		video.removeEventListener("error", onNativeError);
		video.addEventListener("error", onFatal);
		detach = () => {
			video.removeEventListener("error", onFatal);
			release(video);
		};
		video.src = source.mp4;
		if (resumeAt > 0) video.currentTime = resumeAt;
		if (wasPlaying) void video.play().catch(() => undefined);
		else if (resumeAt === 0) start();
	}

	const stop = () => {
		cancelled = true;
		video.removeEventListener("error", onNativeError);
		detach();
	};

	if (mode === "none") {
		onFatal();
		return () => undefined;
	}

	if (mode === "file") {
		playFile({ resumeAt: 0, wasPlaying: false });
		return stop;
	}

	if (mode === "native" && source.hls) {
		video.src = source.hls;
		video.addEventListener("error", onNativeError);
		start();
		return stop;
	}

	loadHls()
		.then(({ default: Hls }) => {
			if (cancelled || !source.hls) return;
			if (!Hls.isSupported()) {
				playFile();
				return;
			}
			const estimate = startingEstimate();
			const hls = new Hls({
				autoStartLoad: false,
				capLevelToPlayerSize: true,
				abrEwmaDefaultEstimate: estimate,
				abrEwmaDefaultEstimateMax: estimate,
				startFragPrefetch: true,
				backBufferLength: 30,
			});
			hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
				hls.startLevel = pickStartingLevel(
					data.levels,
					video.clientWidth * window.devicePixelRatio,
					estimate,
				);
				hls.startLoad();
			});
			let recovered = false;
			hls.on(Hls.Events.ERROR, (_event, data) => {
				if (!data.fatal) return;
				if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
					recovered = true;
					hls.recoverMediaError();
					return;
				}
				const reached = position();
				hls.destroy();
				playFile(reached);
			});
			hls.loadSource(source.hls);
			hls.attachMedia(video);
			detach = () => hls.destroy();
			start();
		})
		.catch(() => playFile());

	return stop;
};
