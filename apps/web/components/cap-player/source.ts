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

type Rendition = { width: number; height: number; bitrate: number };

// Renditions are ranked by resolution, never by bitrate. The ladder is encoded
// at constant quality, so a higher rung of a simple video can carry fewer bits
// than a lower one, and hls.js lists levels in bitrate order.
const sharperFirst = (a: Rendition, b: Rendition) =>
	b.height - a.height || b.width - a.width || b.bitrate - a.bitrate;

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
	return [...best.values()].sort(sharperFirst);
};

const HLS_MIME = "application/vnd.apple.mpegurl";
// The line assumed before anything is measured. Chrome's connection hint
// reads about 1.6 Mbps on a fast line as on a slow one, so it starts low, and
// the first segment's measured speed then swaps a fast line up. Safari and
// Firefox give no hint and assume enough for the rendition that fits a
// desktop player.
const DEFAULT_BITS_PER_SECOND = 5_000_000;
const SLOW_LINE_BITS_PER_SECOND = 500_000;
const SLOW_LINE_TYPES = ["slow-2g", "2g", "3g"];

// Seconds hls.js may buffer ahead of the playhead before anyone presses play.
// Any value below one segment loads exactly the segment under the playhead.
export const SECONDS_AHEAD_BEFORE_PLAY = 1;

// Seconds the segment that fits the player may take to arrive, at the speed
// measured on the segment held first, for it to replace that one before play.
export const SECONDS_TO_SHARPEN = 0.5;

type ConnectionHint = {
	downlink?: number;
	effectiveType?: string;
	saveData?: boolean;
};

const isApple = () => navigator.vendor.includes("Apple");

const playsHlsItself = (video: HTMLVideoElement) =>
	video.canPlayType(HLS_MIME) !== "";

export const pickPlaybackMode = (
	video: HTMLVideoElement,
	source: CapPlayerSource,
): PlaybackMode => {
	if (source.hls) {
		const native = playsHlsItself(video);
		const classic = "MediaSource" in window;
		const mse = classic || "ManagedMediaSource" in window;
		// Safari on a Mac runs hls.js, which can hold one segment before play.
		// iPhone and iPad keep their own HLS player.
		const hlsJs = isApple() ? classic && !navigator.maxTouchPoints : mse;
		if (hlsJs) return "mse";
		if (native) return "native";
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

export const startingEstimate = () => {
	const connection = (navigator as Navigator & { connection?: ConnectionHint })
		.connection;
	if (connection?.saveData === true) return SLOW_LINE_BITS_PER_SECOND;
	const megabits = connection?.downlink ?? 0;
	if (megabits > 0) {
		return Math.min(megabits * 800_000, DEFAULT_BITS_PER_SECOND);
	}
	return SLOW_LINE_TYPES.includes(connection?.effectiveType ?? "")
		? SLOW_LINE_BITS_PER_SECOND
		: DEFAULT_BITS_PER_SECOND;
};

// The smallest rendition that covers the player in either direction, or the
// sharpest below it the line can carry. Returns an index into `levels`.
export const pickStartingLevel = (
	levels: readonly Rendition[],
	player: { width: number; height: number },
	bitsPerSecond: number,
) => {
	const ranked = levels
		.map((level, index) => ({ level, index }))
		.sort((a, b) => -sharperFirst(a.level, b.level));
	let pick = ranked[0]?.index ?? 0;
	for (const [rank, { level, index }] of ranked.entries()) {
		if (rank > 0 && level.bitrate <= bitsPerSecond) pick = index;
		if (level.width >= player.width || level.height >= player.height) break;
	}
	return pick;
};

// Whether level `a` is sharper than level `b`, both indexes into `levels`.
export const isSharper = (
	levels: readonly Rendition[],
	a: number,
	b: number,
) => {
	const first = levels[a];
	const second = levels[b];
	return !!first && (!second || sharperFirst(first, second) < 0);
};

// A long video's playlists sign every segment. Asked for the short form, the
// server signs the first and lists the rest by name, which hls.js follows.
// Safari's own player asks the server again for every segment, so only
// hls.js gets this.
export const withShortPlaylists = (hls: string) => {
	try {
		const url = new URL(hls, document.baseURI);
		url.searchParams.set("segments", "short");
		return url.toString();
	} catch {
		return hls;
	}
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

	const playerSize = () => ({
		width: video.clientWidth * window.devicePixelRatio,
		height: video.clientHeight * window.devicePixelRatio,
	});

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
	let nativeAttached = false;

	function onNativeError() {
		playFile();
	}

	// When hls.js fails, the browser's own HLS is tried before the MP4. Only
	// on Apple browsers: others that claim HLS go straight to the file.
	function playNative({ resumeAt, wasPlaying } = position()) {
		if (cancelled) return;
		const able = playsHlsItself(video) && (mode === "native" || isApple());
		if (!source.hls || nativeAttached || !able) {
			playFile({ resumeAt, wasPlaying });
			return;
		}
		nativeAttached = true;
		setLevel = () => undefined;
		onLevels?.([]);
		detach = () => release(video);
		video.addEventListener("error", onNativeError);
		video.preload = "none";
		video.src = source.hls;
		if (resumeAt > 0) {
			startPending = false;
			video.currentTime = resumeAt;
		}
		if (wasPlaying) void video.play().catch(() => undefined);
		else warmAfterLoad(resumeAt === 0);
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

	// A browser playing HLS itself cannot preload a single segment: at
	// preload="auto" it keeps downloading and cannot be stopped again. So it
	// holds only the playlists until the viewer is about to press play.
	const warm = () => {
		if (!nativeAttached || fileAttached || cancelled) return;
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

	if (mode === "native") {
		playNative({ resumeAt: 0, wasPlaying: false });
		return attachment;
	}

	loadHls()
		.then(({ default: Hls }) => {
			if (cancelled || !source.hls) return;
			if (!Hls.isSupported()) {
				playNative();
				return;
			}
			const estimate = startingEstimate();
			const hls = new Hls({
				autoStartLoad: false,
				capLevelToPlayerSize: true,
				abrEwmaDefaultEstimate: estimate,
				abrEwmaDefaultEstimateMax: estimate,
				startFragPrefetch: true,
				// Safari on a Mac runs hls.js only where it has the classic
				// MediaSource. With the managed one, a seek far ahead never
				// finished in Safari 27: no segment was asked for.
				preferManagedMediaSource: false,
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
				const level = pickStartingLevel(data.levels, playerSize(), estimate);
				hls.startLevel = level;
				if (!playRequested) hls.loadLevel = level;
				hls.startLoad(startPending ? startAt : -1);
			});
			// The first video segment measures the line. When the measured line
			// can fetch a sharper rendition that fits the player in time, that
			// segment is replaced at once, before play or while the first
			// seconds play, rather than playing on soft until the next segment.
			let measured = false;
			let swappedTo = AUTO_LEVEL;
			hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
				if (data.frag.type !== "main") return;
				if (data.frag.level === swappedTo) {
					swappedTo = AUTO_LEVEL;
					// Chrome keeps showing frames it decoded from the old segment
					// until the next keyframe. A seek in place decodes the new one.
					const at = video.currentTime;
					video.currentTime = at;
					// The switch fixed the level; adapting resumes from here.
					if (playRequested && picked === AUTO_LEVEL) {
						hls.loadLevel = AUTO_LEVEL;
					}
					return;
				}
				if (measured) return;
				measured = true;
				if (startPending || picked !== AUTO_LEVEL) return;
				const level = pickStartingLevel(
					hls.levels,
					playerSize(),
					(hls.bandwidthEstimate * SECONDS_TO_SHARPEN) / data.frag.duration,
				);
				if (!isSharper(hls.levels, level, data.frag.level)) return;
				swappedTo = level;
				hls.currentLevel = level;
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
				playNative(reached);
			});
			// A pick changes rendition at the next segment. Switching at once
			// flushes the whole buffer and freezes the picture on a slow line.
			// Before play a pick is only remembered, so it downloads nothing.
			setLevel = (index) => {
				picked = index;
				if (playRequested) hls.nextLevel = index;
			};
			video.preload = "auto";
			hls.loadSource(withShortPlaylists(source.hls));
			hls.attachMedia(video);
			detach = destroy;
			start();
		})
		.catch(() => playNative());

	return attachment;
};
