import type Hls from "hls.js";
import type {
	Fragment,
	LoaderCallbacks,
	LoaderConfiguration,
	LoaderContext,
	PlaylistLoaderConstructor,
} from "hls.js";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ConnectionHint,
	FIRST_FRAME_SWITCH_MS,
	isExpiredMediaStatus,
	type LadderEngine,
	levelIndexForHeight,
	measuredThroughput,
	parseMasterAudioUri,
	parseMasterVariants,
	parseRememberedLine,
	parseShareQuality,
	pickLadderEngine,
	pickStartRendition,
	type QualityOption,
	qualityOptions,
	SHARE_QUALITY_KEY,
	SHARE_THROUGHPUT_KEY,
	type ShareLadderPlayback,
	type ShareQuality,
	STALL_SWITCH_MS,
	serializeRememberedLine,
	serializeShareQuality,
	shouldStartOnLadder,
	switchesOnViewerPause,
	type ThroughputWindow,
	WARM_PLAYLIST_MAX_AGE_MS,
} from "./share-ladder-playback";

type HlsModule = typeof import("hls.js");
type HlsClass = HlsModule["default"];
type Target = "auto" | number;
type Engine = "mp4" | "hls";

type Snapshot = {
	time: number;
	paused: boolean;
	rate: number;
	volume: number;
	muted: boolean;
	trackModes: TextTrackMode[];
};

type Pending =
	| { to: "hls"; mode: LadderEngine; target: Target }
	| { to: "mp4"; snapshot: Snapshot };

type Measurement = {
	startAt: number;
	startBuffered: number;
	progressSeen: boolean;
	done: boolean;
};

export type ShareLadderQualityMenu = {
	options: QualityOption[];
	selected: string;
	onSelect: (id: string) => void;
};

const MOVED_SECONDS = 0.05;

let hlsModule: Promise<HlsModule> | undefined;

const loadHls = () => {
	hlsModule ??= import("hls.js").catch((error: unknown) => {
		hlsModule = undefined;
		throw error;
	});
	return hlsModule;
};

const readStorage = (key: string) => {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
};

const writeStorage = (key: string, value: string) => {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		return;
	}
};

const absoluteUrl = (url: string, base?: string) => {
	try {
		return new URL(url, base ?? window.location.href).href;
	} catch {
		return url;
	}
};

const connectionHint = () =>
	(navigator as Navigator & { connection?: ConnectionHint }).connection;

const bufferedSeconds = (video: HTMLVideoElement) => {
	let total = 0;
	for (let index = 0; index < video.buffered.length; index++) {
		total += video.buffered.end(index) - video.buffered.start(index);
	}
	return total;
};

const fullyBuffered = (video: HTMLVideoElement) => {
	const duration = video.duration;
	if (!Number.isFinite(duration) || duration <= 0) return false;
	for (let index = 0; index < video.buffered.length; index++) {
		if (
			video.buffered.start(index) <= 0.5 &&
			video.buffered.end(index) >= duration - 0.5
		) {
			return true;
		}
	}
	return false;
};

const playerSize = (video: HTMLVideoElement) => {
	const scale = window.devicePixelRatio || 1;
	return {
		width: Math.round(video.clientWidth * scale),
		height: Math.round(video.clientHeight * scale),
	};
};

const fragmentKey = (frag: Fragment | undefined) =>
	frag ? `${frag.type}:${frag.level}:${frag.sn}` : null;

function capture(video: HTMLVideoElement): Snapshot {
	const trackModes: TextTrackMode[] = [];
	for (let index = 0; index < video.textTracks.length; index++) {
		trackModes.push(video.textTracks[index]?.mode ?? "disabled");
	}
	return {
		time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
		paused: video.paused || video.ended,
		rate: video.playbackRate,
		volume: video.volume,
		muted: video.muted,
		trackModes,
	};
}

function restore(video: HTMLVideoElement, snapshot: Snapshot) {
	if (snapshot.time > 0) {
		try {
			video.currentTime = snapshot.time;
		} catch {}
	}
	if (video.playbackRate !== snapshot.rate) video.playbackRate = snapshot.rate;
	if (video.volume !== snapshot.volume) video.volume = snapshot.volume;
	if (video.muted !== snapshot.muted) video.muted = snapshot.muted;
	snapshot.trackModes.forEach((mode, index) => {
		const track = video.textTracks[index];
		if (track && track.mode !== mode) track.mode = mode;
	});
	if (!snapshot.paused) void video.play().catch(() => undefined);
}

// Playlists fetched after the first frame are handed to hls.js from memory,
// so a switch does not wait on the playlist route even when it is uncached.
function warmPlaylistLoader(
	HlsJs: HlsClass,
	take: (url: string) => string | undefined,
): PlaylistLoaderConstructor {
	const Base = HlsJs.DefaultConfig.loader;
	class WarmPlaylistLoader extends Base {
		private timer: ReturnType<typeof setTimeout> | undefined;

		load(
			context: LoaderContext,
			config: LoaderConfiguration,
			callbacks: LoaderCallbacks<LoaderContext>,
		) {
			const text = take(context.url);
			if (text === undefined) {
				super.load(context, config, callbacks);
				return;
			}
			const now = performance.now();
			const stats = this.stats;
			stats.loading.start = now;
			stats.loading.first = now;
			stats.loading.end = now;
			stats.loaded = text.length;
			stats.total = text.length;
			this.context = context;
			this.timer = setTimeout(() => {
				callbacks.onSuccess(
					{ url: context.url, data: text, code: 200 },
					stats,
					context,
					null,
				);
			}, 0);
		}

		abort() {
			clearTimeout(this.timer);
			super.abort();
		}

		destroy() {
			clearTimeout(this.timer);
			super.destroy();
		}
	}
	return WarmPlaylistLoader as unknown as PlaylistLoaderConstructor;
}

export function useShareLadder({
	ladder,
	videoRef,
	active,
	mediaKey,
}: {
	ladder: ShareLadderPlayback | undefined;
	videoRef: RefObject<HTMLVideoElement | null>;
	active: boolean;
	mediaKey: string | undefined;
}) {
	const [engine, setEngine] = useState<Engine>("mp4");
	const [deviceEngine, setDeviceEngine] = useState<LadderEngine | null>(null);
	const [quality, setQuality] = useState<ShareQuality>("auto");
	const [disabled, setDisabled] = useState(false);

	const engineRef = useRef<Engine>("mp4");
	const ladderRef = useRef(ladder);
	ladderRef.current = ladder;
	const activeRef = useRef(active);
	activeRef.current = active;
	const deviceRef = useRef<{
		engine: LadderEngine | null;
		nativeHls: boolean;
		isApple: boolean;
		touchPoints: number;
	}>({ engine: null, nativeHls: false, isApple: false, touchPoints: 0 });
	const qualityRef = useRef<ShareQuality>("auto");
	const disabledRef = useRef(false);
	const lineCalledRef = useRef(false);
	const playRequestedRef = useRef(false);
	const framedRef = useRef(false);
	const playStartRef = useRef(0);
	const viewerPauseHandledRef = useRef(false);
	const measurementRef = useRef<Measurement | null>(null);
	const throughputRef = useRef<number | null>(null);
	const switchingRef = useRef<Target | null>(null);
	const pendingRef = useRef<Pending | null>(null);
	const hlsClassRef = useRef<HlsClass | null>(null);
	const hlsRef = useRef<Hls | null>(null);
	const detachRef = useRef<(() => void) | null>(null);
	const warmedRef = useRef(false);
	const warmRef = useRef(new Map<string, { text: string; at: number }>());
	const mountedRef = useRef(true);

	const ladderKey = ladder?.masterUrl;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			detachRef.current?.();
			detachRef.current = null;
		};
	}, []);

	useEffect(() => {
		const current = ladderRef.current;
		if (!ladderKey || !current) return;
		const isApple = navigator.vendor.includes("Apple");
		const touchPoints = navigator.maxTouchPoints ?? 0;
		const nativeHls =
			document
				.createElement("video")
				.canPlayType("application/vnd.apple.mpegurl") !== "";
		const picked = pickLadderEngine({
			isApple,
			classicMediaSource: "MediaSource" in window,
			managedMediaSource: "ManagedMediaSource" in window,
			touchPoints,
			nativeHls,
		});
		deviceRef.current = { engine: picked, nativeHls, isApple, touchPoints };
		const stored = parseShareQuality(
			readStorage(SHARE_QUALITY_KEY),
			picked === "hlsjs" ? current.renditions : [],
		);
		qualityRef.current = stored;
		setQuality(stored);
		setDeviceEngine(picked);
	}, [ladderKey]);

	const estimate = useCallback(() => {
		if (throughputRef.current !== null) return throughputRef.current;
		const downlink = connectionHint()?.downlink;
		return typeof downlink === "number" && downlink > 0 ? downlink * 1e6 : null;
	}, []);

	const takeWarm = useCallback((url: string) => {
		const key = absoluteUrl(url);
		const entry = warmRef.current.get(key);
		if (!entry) return undefined;
		warmRef.current.delete(key);
		if (performance.now() - entry.at > WARM_PLAYLIST_MAX_AGE_MS) {
			return undefined;
		}
		return entry.text;
	}, []);

	const warm = useCallback(async () => {
		const current = ladderRef.current;
		const video = videoRef.current;
		if (warmedRef.current || !current || !video) return;
		warmedRef.current = true;
		const fetchText = async (url: string) => {
			try {
				const response = await fetch(url, { credentials: "same-origin" });
				return response.ok ? await response.text() : null;
			} catch {
				return null;
			}
		};
		const masterUrl = absoluteUrl(current.masterUrl);
		const master = await fetchText(masterUrl);
		if (!master) return;
		warmRef.current.set(masterUrl, { text: master, at: performance.now() });
		const start = pickStartRendition(
			current.renditions,
			playerSize(video),
			estimate(),
		);
		const variant = parseMasterVariants(master).find(
			(entry) => entry.height === start?.height,
		);
		const audio = parseMasterAudioUri(master);
		const urls = [variant?.uri, audio ?? undefined]
			.filter((uri): uri is string => Boolean(uri))
			.map((uri) => absoluteUrl(uri, masterUrl));
		await Promise.all(
			urls.map(async (url) => {
				const text = await fetchText(url);
				if (text) warmRef.current.set(url, { text, at: performance.now() });
			}),
		);
	}, [estimate, videoRef]);

	const applyLevel = useCallback((target: Target) => {
		const hls = hlsRef.current;
		if (!hls) return;
		if (target === "auto") {
			hls.loadLevel = -1;
			return;
		}
		const index = levelIndexForHeight(hls.levels, target);
		if (index < 0) return;
		if (hls.currentLevel === index) hls.loadLevel = index;
		else hls.currentLevel = index;
	}, []);

	const switchToMp4 = useCallback(() => {
		const video = videoRef.current;
		if (engineRef.current !== "hls" || !video) return;
		const snapshot = capture(video);
		detachRef.current?.();
		detachRef.current = null;
		if (video.hasAttribute("src")) {
			video.removeAttribute("src");
			video.load();
		}
		if (snapshot.time > 0) {
			try {
				video.currentTime = snapshot.time;
			} catch {}
		}
		pendingRef.current = { to: "mp4", snapshot };
		engineRef.current = "mp4";
		setEngine("mp4");
	}, [videoRef]);

	const fallBackToMp4 = useCallback(() => {
		disabledRef.current = true;
		setDisabled(true);
		switchToMp4();
	}, [switchToMp4]);

	const switchToHls = useCallback(
		async (target: Target) => {
			const device = deviceRef.current;
			if (!ladderRef.current || !device.engine || disabledRef.current) return;
			if (engineRef.current === "hls") {
				applyLevel(target);
				return;
			}
			if (switchingRef.current !== null) {
				switchingRef.current = target;
				return;
			}
			switchingRef.current = target;
			let mode: LadderEngine | null = device.engine;
			if (mode === "hlsjs") {
				try {
					const { default: HlsJs } = await loadHls();
					hlsClassRef.current = HlsJs;
					if (!HlsJs.isSupported()) mode = device.nativeHls ? "native" : null;
				} catch {
					mode = null;
				}
			}
			const latest = switchingRef.current ?? target;
			switchingRef.current = null;
			if (
				!mountedRef.current ||
				!activeRef.current ||
				engineRef.current !== "mp4" ||
				disabledRef.current ||
				qualityRef.current === "original"
			) {
				return;
			}
			if (!mode) {
				disabledRef.current = true;
				setDisabled(true);
				return;
			}
			pendingRef.current = { to: "hls", mode, target: latest };
			engineRef.current = "hls";
			setEngine("hls");
		},
		[applyLevel],
	);

	const attachHls = useCallback(
		(video: HTMLVideoElement, mode: LadderEngine, target: Target) => {
			const current = ladderRef.current;
			if (!current) return;
			const snapshot = capture(video);
			if (mode === "native") {
				const onError = () => fallBackToMp4();
				video.addEventListener("error", onError);
				detachRef.current = () => video.removeEventListener("error", onError);
				video.src = current.masterUrl;
				restore(video, snapshot);
				return;
			}
			const HlsJs = hlsClassRef.current;
			if (!HlsJs) {
				fallBackToMp4();
				return;
			}
			const bitsPerSecond = estimate();
			const start =
				target === "auto"
					? pickStartRendition(
							current.renditions,
							playerSize(video),
							bitsPerSecond,
						)
					: (current.renditions.find(
							(rendition) => rendition.height === target,
						) ?? null);
			let startHeight = start?.height ?? null;
			const hls = new HlsJs({
				autoStartLoad: false,
				startPosition: snapshot.time,
				capLevelToPlayerSize: true,
				startFragPrefetch: true,
				preferManagedMediaSource: false,
				backBufferLength: 30,
				...(bitsPerSecond ? { abrEwmaDefaultEstimate: bitsPerSecond } : {}),
				pLoader: warmPlaylistLoader(HlsJs, takeWarm),
				// The share's captions are <track> elements. Left on, these hls.js
				// parts clear their cues when a manifest loads.
				subtitleStreamController: undefined,
				subtitleTrackController: undefined,
				timelineController: undefined,
			});
			hlsRef.current = hls;
			let reloadedFor: string | null = null;
			hls.on(HlsJs.Events.MANIFEST_PARSED, (_event, data) => {
				const startIndex =
					startHeight === null
						? -1
						: levelIndexForHeight(data.levels, startHeight);
				if (startIndex >= 0) hls.startLevel = startIndex;
				const pinned = qualityRef.current;
				if (typeof pinned === "number") {
					const index = levelIndexForHeight(data.levels, pinned);
					if (index >= 0) hls.loadLevel = index;
				}
				hls.startLoad(hls.config.startPosition);
			});
			hls.on(HlsJs.Events.LEVEL_SWITCHED, (_event, data) => {
				startHeight = hls.levels[data.level]?.height ?? startHeight;
			});
			hls.on(HlsJs.Events.FRAG_LOADED, (_event, data) => {
				if (fragmentKey(data.frag) === reloadedFor) reloadedFor = null;
			});
			hls.on(HlsJs.Events.ERROR, (_event, data) => {
				if (hlsRef.current !== hls) return;
				const key = fragmentKey(data.frag);
				if (
					isExpiredMediaStatus(data.response?.code) &&
					(data.details === HlsJs.ErrorDetails.FRAG_LOAD_ERROR ||
						data.details === HlsJs.ErrorDetails.KEY_LOAD_ERROR) &&
					key !== reloadedFor
				) {
					// Signed media URLs expire after an hour. A fragment refused
					// again with fresh URLs has not expired, so it falls through.
					reloadedFor = key;
					warmRef.current.clear();
					const resume = capture(video);
					hls.config.startPosition = resume.time;
					hls.loadSource(current.masterUrl);
					restore(video, resume);
					return;
				}
				if (data.fatal) fallBackToMp4();
			});
			detachRef.current = () => {
				if (hlsRef.current === hls) hlsRef.current = null;
				hls.destroy();
			};
			hls.loadSource(current.masterUrl);
			hls.attachMedia(video);
			restore(video, snapshot);
		},
		[estimate, fallBackToMp4, takeWarm],
	);

	useLayoutEffect(() => {
		void engine;
		const pending = pendingRef.current;
		const video = videoRef.current;
		if (!pending || !video) return;
		pendingRef.current = null;
		if (pending.to === "hls") attachHls(video, pending.mode, pending.target);
		else restore(video, pending.snapshot);
	}, [attachHls, engine, videoRef]);

	useEffect(() => {
		if (!active && engine === "hls") switchToMp4();
	}, [active, engine, switchToMp4]);

	const finishMeasurement = useCallback(
		(force: boolean) => {
			const video = videoRef.current;
			const measurement = measurementRef.current;
			const current = ladderRef.current;
			if (!video || !measurement || measurement.done || !current) return;
			if (!measurement.progressSeen) {
				if (force) measurement.done = true;
				return;
			}
			const window: ThroughputWindow = {
				gainedSeconds: bufferedSeconds(video) - measurement.startBuffered,
				elapsedMs: performance.now() - measurement.startAt,
				fullyBuffered: fullyBuffered(video),
			};
			const bitsPerSecond = measuredThroughput(
				window,
				current.source.bitsPerSecond,
				force,
			);
			if (bitsPerSecond !== null) {
				throughputRef.current = bitsPerSecond;
				writeStorage(
					SHARE_THROUGHPUT_KEY,
					serializeRememberedLine(bitsPerSecond, Date.now()),
				);
			}
			if (bitsPerSecond !== null || force || window.fullyBuffered) {
				measurement.done = true;
			}
		},
		[videoRef],
	);

	const lineCallsForLadder = useCallback(() => {
		const current = ladderRef.current;
		if (!current) return false;
		return shouldStartOnLadder({
			connection: connectionHint(),
			rememberedBitsPerSecond: parseRememberedLine(
				readStorage(SHARE_THROUGHPUT_KEY),
				Date.now(),
			),
			sourceBitsPerSecond: current.source.bitsPerSecond,
		});
	}, []);

	const callForLadder = useCallback(() => {
		lineCalledRef.current = true;
		finishMeasurement(true);
		if (qualityRef.current === "auto") void switchToHls("auto");
	}, [finishMeasurement, switchToHls]);

	const firstFrameTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// Safari reports enough data and fires "playing" while it holds the first
	// frame on a line too slow for the MP4, so only the clock moving counts as
	// a first frame.
	const armFirstFrame = useCallback(() => {
		clearTimeout(firstFrameTimerRef.current);
		firstFrameTimerRef.current = setTimeout(() => {
			firstFrameTimerRef.current = undefined;
			const video = videoRef.current;
			if (
				video &&
				engineRef.current === "mp4" &&
				!framedRef.current &&
				!video.paused &&
				!video.ended &&
				!video.error
			) {
				callForLadder();
			}
		}, FIRST_FRAME_SWITCH_MS);
	}, [callForLadder, videoRef]);

	useEffect(() => {
		const video = videoRef.current;
		const current = ladderRef.current;
		void mediaKey;
		if (!current || !ladderKey || !active || !deviceEngine || !video) return;
		if (engine !== "mp4" || disabled) return;

		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const clearStall = () => {
			clearTimeout(stallTimer);
			stallTimer = undefined;
		};

		const onPlayRequested = () => {
			if (!framedRef.current) {
				playStartRef.current = video.currentTime;
				armFirstFrame();
			}
			if (playRequestedRef.current) return;
			playRequestedRef.current = true;
			measurementRef.current = {
				startAt: performance.now(),
				startBuffered: bufferedSeconds(video),
				progressSeen: false,
				done: false,
			};
			const picked = qualityRef.current;
			if (typeof picked === "number") {
				void switchToHls(picked);
				return;
			}
			if (picked === "original") return;
			if (lineCallsForLadder()) {
				lineCalledRef.current = true;
				void switchToHls("auto");
			}
		};

		const onTimeUpdate = () => {
			finishMeasurement(false);
			if (
				!playRequestedRef.current ||
				framedRef.current ||
				video.paused ||
				video.currentTime - playStartRef.current < MOVED_SECONDS
			) {
				return;
			}
			framedRef.current = true;
			clearTimeout(firstFrameTimerRef.current);
			void warm();
		};

		const onProgress = () => {
			const measurement = measurementRef.current;
			if (measurement) measurement.progressSeen = true;
			finishMeasurement(false);
		};

		const onWaiting = () => {
			if (!framedRef.current || video.paused) return;
			clearStall();
			const stalledAt = video.currentTime;
			stallTimer = setTimeout(() => {
				stallTimer = undefined;
				if (
					!video.paused &&
					!video.ended &&
					video.currentTime - stalledAt < MOVED_SECONDS
				) {
					callForLadder();
				}
			}, STALL_SWITCH_MS);
		};

		const viewerPause = () => {
			if (
				viewerPauseHandledRef.current ||
				qualityRef.current !== "auto" ||
				!switchesOnViewerPause(current, deviceRef.current)
			) {
				return;
			}
			viewerPauseHandledRef.current = true;
			void switchToHls("auto");
		};

		const onPause = () => {
			clearStall();
			clearTimeout(firstFrameTimerRef.current);
			// A paused element may stop fetching, so time spent paused would
			// read as a slow line.
			const measurement = measurementRef.current;
			if (measurement) measurement.done = true;
			viewerPause();
		};

		const onVisibility = () => {
			if (document.visibilityState === "hidden") viewerPause();
		};

		video.addEventListener("play", onPlayRequested);
		video.addEventListener("timeupdate", onTimeUpdate);
		video.addEventListener("progress", onProgress);
		video.addEventListener("waiting", onWaiting);
		video.addEventListener("playing", clearStall);
		video.addEventListener("pause", onPause);
		video.addEventListener("seeking", viewerPause);
		document.addEventListener("visibilitychange", onVisibility);
		if (!video.paused) onPlayRequested();

		return () => {
			clearTimeout(firstFrameTimerRef.current);
			clearStall();
			video.removeEventListener("play", onPlayRequested);
			video.removeEventListener("timeupdate", onTimeUpdate);
			video.removeEventListener("progress", onProgress);
			video.removeEventListener("waiting", onWaiting);
			video.removeEventListener("playing", clearStall);
			video.removeEventListener("pause", onPause);
			video.removeEventListener("seeking", viewerPause);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [
		active,
		armFirstFrame,
		callForLadder,
		deviceEngine,
		disabled,
		engine,
		finishMeasurement,
		ladderKey,
		lineCallsForLadder,
		mediaKey,
		switchToHls,
		videoRef,
		warm,
	]);

	const selectQuality = useCallback(
		(id: string) => {
			const current = ladderRef.current;
			if (!current) return;
			const next = parseShareQuality(
				id,
				deviceRef.current.engine === "hlsjs" ? current.renditions : [],
			);
			qualityRef.current = next;
			setQuality(next);
			writeStorage(SHARE_QUALITY_KEY, serializeShareQuality(next));
			if (next === "original") {
				switchToMp4();
				return;
			}
			if (typeof next === "number") {
				void switchToHls(next);
				return;
			}
			if (engineRef.current !== "hls") {
				const video = videoRef.current;
				if (!playRequestedRef.current || !video || video.paused) return;
				if (lineCalledRef.current || lineCallsForLadder()) {
					lineCalledRef.current = true;
					void switchToHls("auto");
					return;
				}
				if (!framedRef.current) armFirstFrame();
				return;
			}
			if (lineCalledRef.current || lineCallsForLadder()) {
				lineCalledRef.current = true;
				applyLevel("auto");
				return;
			}
			switchToMp4();
		},
		[
			applyLevel,
			armFirstFrame,
			lineCallsForLadder,
			switchToHls,
			switchToMp4,
			videoRef,
		],
	);

	const qualityMenu = useMemo<ShareLadderQualityMenu | undefined>(() => {
		if (!ladder || !active || !deviceEngine || disabled) return undefined;
		return {
			options: qualityOptions(ladder, deviceEngine === "hlsjs"),
			selected: serializeShareQuality(quality),
			onSelect: selectQuality,
		};
	}, [active, deviceEngine, disabled, ladder, quality, selectQuality]);

	const playingLadder = useCallback(() => engineRef.current === "hls", []);

	return { engine, playingLadder, qualityMenu };
}
