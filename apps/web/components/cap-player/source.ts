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
	sharpen: () => void;
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

const RENDITION_URI = /^(\d{3,4}p)\.m3u8(?:$|\?)/;

export interface MasterLevel {
	width: number;
	height: number;
	bitrate: number;
	uri: string;
}

export const parseMasterLevels = (master: string): MasterLevel[] => {
	const lines = master.split(/\r?\n/).map((line) => line.trim());
	const levels: MasterLevel[] = [];
	lines.forEach((line, index) => {
		if (!line.startsWith("#EXT-X-STREAM-INF:")) return;
		const uri = lines[index + 1];
		if (!uri || !RENDITION_URI.test(uri)) return;
		const resolution = /[:,]RESOLUTION=(\d+)x(\d+)/.exec(line);
		levels.push({
			width: Number(resolution?.[1] ?? 0),
			height: Number(resolution?.[2] ?? 0),
			bitrate: Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0),
			uri,
		});
	});
	return levels;
};

// Safari's own HLS player picks renditions by itself and lets no page pick
// one. Picking means loading a master playlist that lists only that
// rendition, with its audio, so the time and play state carry over.
export const renditionSource = (hls: string, uri: string | undefined) => {
	const name = RENDITION_URI.exec(uri ?? "")?.[1];
	if (!name) return null;
	try {
		const url = new URL(hls, document.baseURI);
		url.searchParams.set("rendition", name);
		return url.toString();
	} catch {
		return null;
	}
};

const HLS_MIME = "application/vnd.apple.mpegurl";
// Safari and Firefox give no connection estimate. Assuming a slow line costs
// a fast one its first segment at a lower rendition. Assuming a fast line
// costs a slow one several seconds before the first frame.
const DEFAULT_BITS_PER_SECOND = 1_500_000;

// Seconds hls.js may buffer ahead of the playhead before anyone presses play.
// Any value below one segment loads exactly the segment under the playhead.
export const SECONDS_AHEAD_BEFORE_PLAY = 1;

// Seconds a sharper first segment may take to arrive once the pointer rests
// on play, before the click that usually follows.
export const SECONDS_TO_SHARPEN = 0.5;

type ConnectionHint = { downlink?: number };

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
	let sharpen = () => undefined;

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
	let nativeAttached = false;
	let nativeLevels: MasterLevel[] = [];
	let nativeSrc = "";
	let listing: AbortController | null = null;

	function onNativeError() {
		playFile();
	}

	function listNativeLevels() {
		video.removeEventListener("loadedmetadata", listNativeLevels);
		const hls = source.hls;
		if (!hls || listing || cancelled || fileAttached) return;
		listing = new AbortController();
		fetch(hls, { signal: listing.signal })
			.then((response) => (response.ok ? response.text() : ""))
			.then((master) => {
				if (cancelled || fileAttached) return;
				nativeLevels = parseMasterLevels(master);
				onLevels?.(listLevels(nativeLevels));
			})
			.catch(() => undefined);
	}

	function pickNativeLevel(index: number) {
		const hls = source.hls;
		if (!hls || fileAttached) return;
		const next =
			index === AUTO_LEVEL
				? hls
				: renditionSource(hls, nativeLevels[index]?.uri);
		if (!next || next === nativeSrc) return;
		const { resumeAt, wasPlaying } = position();
		nativeSrc = next;
		video.src = next;
		if (resumeAt > 0) {
			video.addEventListener(
				"loadedmetadata",
				() => {
					video.currentTime = resumeAt;
				},
				{ once: true },
			);
		}
		if (wasPlaying) void video.play().catch(() => undefined);
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
		setLevel = pickNativeLevel;
		onLevels?.([]);
		detach = () => release(video);
		video.addEventListener("error", onNativeError);
		video.addEventListener("loadedmetadata", listNativeLevels);
		video.preload = "none";
		nativeSrc = source.hls;
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
		listing?.abort();
		video.removeEventListener("error", onNativeError);
		video.removeEventListener("loadedmetadata", listNativeLevels);
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
		sharpen: () => sharpen(),
		setLevel: (index) => setLevel(index),
	};

	if (mode === "none") {
		onFatal();
		return {
			stop: () => undefined,
			warm: () => undefined,
			sharpen: () => undefined,
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
				// Cap's streams carry no subtitle renditions and no captions inside
				// the video. Left on, these hls.js parts clear the cues of every
				// caption track on the video when a manifest loads and switch the
				// tracks off when it detaches, which emptied the player's own
				// captions in Chrome.
				subtitleStreamController: undefined,
				subtitleTrackController: undefined,
				timelineController: undefined,
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
				sharpen = () => undefined;
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
			// The segment held before play measures the line. When the pointer
			// rests on play and that line can fetch a sharper first segment in
			// time, the held one is swapped for the rendition that fits the
			// player, so a fast line does not play its first seconds soft.
			let heldSeconds = 0;
			let swappedTo = AUTO_LEVEL;
			// A pointer can rest on play before the held segment has arrived.
			// The swap then waits for it.
			let sharpenWhenHeld = false;
			hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
				if (data.frag.type !== "main") return;
				if (!playRequested) heldSeconds = data.frag.duration;
				// Chrome keeps showing frames it decoded from the old segment
				// until the next keyframe. A seek in place decodes the new one.
				if (data.frag.level === swappedTo) {
					swappedTo = AUTO_LEVEL;
					const at = video.currentTime;
					video.currentTime = at;
				}
				if (sharpenWhenHeld) sharpen();
			});
			sharpen = () => {
				if (playRequested || startPending || picked !== AUTO_LEVEL) return;
				sharpenWhenHeld = !heldSeconds;
				if (!heldSeconds) return;
				const level = pickStartingLevel(
					hls.levels,
					video.clientWidth * window.devicePixelRatio,
					(hls.bandwidthEstimate * SECONDS_TO_SHARPEN) / heldSeconds,
				);
				if (level <= hls.loadLevel) return;
				heldSeconds = 0;
				swappedTo = level;
				hls.currentLevel = level;
			};
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
