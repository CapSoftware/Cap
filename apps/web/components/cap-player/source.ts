export interface CapPlayerSource {
	hls?: string;
	mp4?: string;
}

export type PlaybackMode = "native" | "mse" | "file" | "none";

export interface CapPlayerLevel {
	index: number;
	width: number;
	height: number;
	bitrate: number;
	label: string;
}

export interface CapPlayerAttachment {
	detach: () => void;
	setLevel: (index: number) => void;
}

export type CapPlayerPreload = "auto" | "metadata";

export const AUTO_LEVEL = -1;

export const resolutionLabel = (width: number, height: number) => {
	const long = Math.max(width, height);
	if (long >= 3840) return "4K";
	if (long >= 2560) return "1440p";
	if (long >= 1920) return "1080p";
	if (long >= 1280) return "720p";
	return long > 0 ? "360p" : "";
};

export const listLevels = (
	levels: readonly { width: number; height: number; bitrate: number }[],
): CapPlayerLevel[] => {
	const best = new Map<string, CapPlayerLevel>();
	levels.forEach((level, index) => {
		const label = resolutionLabel(level.width, level.height);
		if (!label) return;
		const kept = best.get(label);
		if (!kept || level.bitrate > kept.bitrate) {
			best.set(label, { index, label, ...level });
		}
	});
	return [...best.values()].sort(
		(a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate,
	);
};

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
	options: {
		autoPlay: boolean;
		preload?: CapPlayerPreload;
		onFatal: () => void;
		onLevels?: (levels: CapPlayerLevel[]) => void;
	},
): CapPlayerAttachment => {
	const { autoPlay, onFatal, onLevels } = options;
	const eager = autoPlay || options.preload === "auto";
	const mode = pickPlaybackMode(video, source);
	let cancelled = false;
	let detach = () => release(video);
	let setLevel: (index: number) => void = () => undefined;

	const start = () => {
		if (!autoPlay) return;
		void video.play().catch((error: unknown) => {
			const blocked =
				error instanceof DOMException && error.name === "NotAllowedError";
			if (!blocked || video.muted) return;
			video.muted = true;
			void video.play().catch(() => undefined);
		});
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
		setLevel = () => undefined;
		onLevels?.([]);
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

	const attachment: CapPlayerAttachment = {
		detach: () => {
			cancelled = true;
			video.removeEventListener("error", onNativeError);
			detach();
		},
		setLevel: (index) => setLevel(index),
	};

	if (mode === "none") {
		onFatal();
		return { detach: () => undefined, setLevel: () => undefined };
	}

	if (mode === "file") {
		playFile({ resumeAt: 0, wasPlaying: false });
		return attachment;
	}

	if (mode === "native" && source.hls) {
		video.src = source.hls;
		video.addEventListener("error", onNativeError);
		start();
		return attachment;
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
				onLevels?.(listLevels(data.levels));
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
			const resume = () => {
				video.removeEventListener("play", resume);
				video.removeEventListener("seeking", resume);
				hls.startLoad();
			};
			if (!eager) {
				hls.once(Hls.Events.FRAG_BUFFERED, () => {
					if (!video.paused || video.seeking) return;
					hls.stopLoad();
					video.addEventListener("play", resume);
					video.addEventListener("seeking", resume);
				});
			}
			hls.loadSource(source.hls);
			hls.attachMedia(video);
			detach = () => {
				video.removeEventListener("play", resume);
				video.removeEventListener("seeking", resume);
				hls.destroy();
			};
			setLevel = (index) => {
				hls.nextLevel = index;
			};
			start();
		})
		.catch(() => playFile());

	return attachment;
};
