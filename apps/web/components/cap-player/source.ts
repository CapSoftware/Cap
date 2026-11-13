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

export interface Attachment {
	stop: () => void;
	warm: () => void;
	setLevel: (index: number) => void;
}

export interface AttachOptions {
	autoPlay: boolean;
	startAt?: number;
	onFatal: () => void;
	onLevels?: (levels: CapPlayerLevel[]) => void;
}

export const AUTO_LEVEL = -1;

export const resolutionLabel = (width: number, height: number) => {
	const long = Math.max(width, height);
	if (long >= 3840) return "4K";
	if (long >= 2560) return "1440p";
	if (long >= 1920) return "1080p";
	if (long >= 1280) return "720p";
	return long > 0 ? "360p" : "";
};

const NAMED_RENDITION = /(?:^|\/)(\d{3,4})p(?:\.m3u8)?(?:$|[?#])/;

export const renditionLabel = (level: {
	width: number;
	height: number;
	name?: string;
	uri?: string;
}) => {
	const named =
		NAMED_RENDITION.exec(level.name ?? "") ??
		NAMED_RENDITION.exec(level.uri ?? "");
	if (named) return named[1] === "2160" ? "4K" : `${named[1]}p`;
	return resolutionLabel(level.width, level.height);
};

export const listLevels = (
	levels: readonly {
		width: number;
		height: number;
		bitrate: number;
		name?: string;
		uri?: string;
	}[],
): CapPlayerLevel[] => {
	const best = new Map<string, CapPlayerLevel>();
	levels.forEach((level, index) => {
		const label = renditionLabel(level);
		if (!label) return;
		const kept = best.get(label);
		if (!kept || level.bitrate > kept.bitrate) {
			best.set(label, {
				index,
				label,
				width: level.width,
				height: level.height,
				bitrate: level.bitrate,
			});
		}
	});
	return [...best.values()].sort(
		(a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate,
	);
};

const HLS_MIME = "application/vnd.apple.mpegurl";
const DEFAULT_BITS_PER_SECOND = 5_000_000;

// Seconds hls.js may buffer ahead of the playhead before anyone presses play.
// Any value below one segment loads exactly the segment under the playhead.
export const SECONDS_AHEAD_BEFORE_PLAY = 1;

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

export const startWithin = (startAt: number, duration: number) =>
	Number.isFinite(duration) && startAt > 0 && startAt < duration ? startAt : 0;

// A browser that refuses to start with sound is asked again without it. One
// that refuses both leaves the video paused with its sound setting untouched.
export const playAllowingMuted = async (
	video: Pick<HTMLVideoElement, "play" | "muted">,
) => {
	try {
		await video.play();
	} catch (error) {
		const refused = error instanceof Error && error.name === "NotAllowedError";
		if (!refused || video.muted) return;
		video.muted = true;
		try {
			await video.play();
		} catch {
			video.muted = false;
		}
	}
};

const release = (video: HTMLVideoElement) => {
	video.removeAttribute("src");
	video.load();
};

const afterDocumentLoad = (run: () => void) => {
	if (document.readyState === "complete") {
		run();
		return () => undefined;
	}
	window.addEventListener("load", run, { once: true });
	return () => window.removeEventListener("load", run);
};

export const attachSource = (
	video: HTMLVideoElement,
	source: CapPlayerSource,
	options: AttachOptions,
): Attachment => {
	const { autoPlay, onFatal, onLevels } = options;
	const startAt = options.startAt ?? 0;
	const mode = pickPlaybackMode(video, source);
	let cancelled = false;
	let detach = () => release(video);
	let cancelWarm: () => void = () => undefined;
	let startPending = startAt > 0;
	let hlsSeeks = false;
	let setLevel: (index: number) => void = () => undefined;

	const start = () => {
		if (autoPlay) void playAllowingMuted(video);
	};

	const position = () => ({
		resumeAt: video.currentTime,
		wasPlaying: !video.paused,
	});

	const seekToStart = () => {
		if (!startPending || hlsSeeks) return;
		startPending = false;
		const at = startWithin(startAt, video.duration);
		if (at > 0) video.currentTime = at;
	};

	// WebKit holds the document's load event, and with it the load event of a
	// page that embeds this one, for as long as a media element with a source
	// is preloading. So the element starts at preload="none" and only reads
	// its metadata, or autoplays, once the document has loaded.
	const warmAfterLoad = (fromTheStart: boolean) => {
		cancelWarm();
		cancelWarm = afterDocumentLoad(() => {
			if (cancelled) return;
			if (video.paused) video.preload = "metadata";
			if (fromTheStart) start();
		});
	};

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
		video.preload = "none";
		video.src = source.mp4;
		if (resumeAt > 0) {
			startPending = false;
			video.currentTime = resumeAt;
		}
		if (wasPlaying) void video.play().catch(() => undefined);
		else warmAfterLoad(resumeAt === 0);
	}

	const stop = () => {
		cancelled = true;
		cancelWarm();
		video.removeEventListener("error", onNativeError);
		video.removeEventListener("loadedmetadata", seekToStart);
		detach();
	};

	// Safari plays HLS itself and cannot preload a single segment: at
	// preload="auto" it keeps downloading and cannot be stopped again. So it
	// holds only the playlists until the viewer is about to press play.
	const warm = () => {
		if (mode !== "native" || fileAttached || cancelled) return;
		if (video.paused && document.readyState === "complete") {
			video.preload = "auto";
		}
	};

	const attachment: Attachment = {
		stop,
		warm,
		setLevel: (index) => setLevel(index),
	};

	if (mode === "none") {
		onFatal();
		return {
			stop: () => undefined,
			warm: () => undefined,
			setLevel: () => undefined,
		};
	}

	video.addEventListener("loadedmetadata", seekToStart);

	if (mode === "file") {
		playFile({ resumeAt: 0, wasPlaying: false });
		return attachment;
	}

	if (mode === "native" && source.hls) {
		video.preload = "none";
		video.src = source.hls;
		video.addEventListener("error", onNativeError);
		warmAfterLoad(true);
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
				maxMaxBufferLength: SECONDS_AHEAD_BEFORE_PLAY,
			});
			let playRequested = false;
			let picked = AUTO_LEVEL;
			const bufferFreely = () => {
				playRequested = true;
				hls.config.maxMaxBufferLength = Hls.DefaultConfig.maxMaxBufferLength;
				if (picked === AUTO_LEVEL) hls.loadLevel = AUTO_LEVEL;
				else hls.nextLevel = picked;
			};
			// hls.js seeks to the start time itself. The time stays pending
			// until that seek lands, so a fallback to the MP4 before then
			// still starts at it.
			const reachedStart = () => {
				startPending = false;
			};
			const destroy = () => {
				hlsSeeks = false;
				video.removeEventListener("play", bufferFreely);
				video.removeEventListener("seeked", reachedStart);
				hls.destroy();
			};
			hlsSeeks = true;
			video.addEventListener("seeked", reachedStart, { once: true });
			video.addEventListener("play", bufferFreely);
			if (!video.paused) bufferFreely();
			// Until play, hls.js keeps to one rendition and one segment. The
			// level is fixed because the first segment's speed reading would
			// otherwise send it off to fetch a second rendition's playlist.
			hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
				onLevels?.(listLevels(data.levels));
				const level = pickStartingLevel(
					data.levels,
					video.clientWidth * window.devicePixelRatio,
					estimate,
				);
				hls.startLevel = level;
				if (!playRequested) hls.loadLevel = level;
				hls.startLoad(startPending ? startAt : -1);
			});
			hls.once(Hls.Events.LEVEL_LOADED, (_event, data) => {
				if (!startPending) return;
				if (startWithin(startAt, data.details.totalduration) === 0) {
					startPending = false;
					hls.startLoad(0);
				}
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
				destroy();
				playFile(reached);
			});
			// A pick changes rendition at the next segment. Switching at once
			// flushes the whole buffer and freezes the picture on a slow line.
			// Before play a pick is only remembered, so it downloads nothing.
			setLevel = (index) => {
				picked = index;
				if (playRequested) hls.nextLevel = index;
			};
			video.preload = "auto";
			hls.loadSource(source.hls);
			hls.attachMedia(video);
			detach = destroy;
			start();
		})
		.catch(() => playFile());

	return attachment;
};
