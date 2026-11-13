import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTO_LEVEL,
	attachSource,
	isSharper,
	listLevels,
	parseMasterLevels,
	pickPlaybackMode,
	pickStartingLevel,
	playAllowingMuted,
	renditionSource,
	SECONDS_AHEAD_BEFORE_PLAY,
	SECONDS_TO_SHARPEN,
	startingEstimate,
	startWithin,
	withShortPlaylists,
} from "@/components/cap-player/source";

type Listener = (event: string, data: unknown) => void;

const hlsMock = vi.hoisted(() => {
	class FakeHls {
		static instances: FakeHls[] = [];
		static isSupported = () => true;
		static Events = {
			MANIFEST_PARSED: "manifestParsed",
			LEVEL_LOADED: "levelLoaded",
			FRAG_BUFFERED: "fragBuffered",
			ERROR: "error",
		};
		static ErrorTypes = { MEDIA_ERROR: "mediaError" };
		static DefaultConfig = { maxMaxBufferLength: 600 };

		config: {
			maxMaxBufferLength: number;
			abrEwmaDefaultEstimate?: number;
		};
		startLevel = -1;
		loadLevel = -1;
		currentLevel = -1;
		levels: unknown[] = [];
		bandwidthEstimate = Number.NaN;
		startLoads: number[] = [];
		source = "";
		destroyed = false;
		private listeners = new Map<string, Listener[]>();

		constructor(config: {
			maxMaxBufferLength: number;
			abrEwmaDefaultEstimate?: number;
		}) {
			this.config = { ...config };
			FakeHls.instances.push(this);
		}

		on(name: string, listener: Listener) {
			this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
		}

		once(name: string, listener: Listener) {
			const wrapped: Listener = (event, data) => {
				this.listeners.set(
					name,
					(this.listeners.get(name) ?? []).filter((l) => l !== wrapped),
				);
				listener(event, data);
			};
			this.on(name, wrapped);
		}

		emit(name: string, data: unknown) {
			if (name === "manifestParsed") {
				this.levels = (data as { levels: unknown[] }).levels;
			}
			for (const listener of this.listeners.get(name) ?? []) {
				listener(name, data);
			}
		}

		startLoad(position = -1) {
			this.startLoads.push(position);
		}

		loadSource(url: string) {
			this.source = url;
		}

		attachMedia() {}

		recoverMediaError() {}

		destroy() {
			this.destroyed = true;
		}
	}
	return { FakeHls };
});

vi.mock("hls.js", () => ({ default: hlsMock.FakeHls }));

const LADDER = [
	{ bitrate: 450_000, width: 640, height: 360 },
	{ bitrate: 3_400_000, width: 1280, height: 720 },
	{ bitrate: 6_650_000, width: 1920, height: 1080 },
	{ bitrate: 11_400_000, width: 2560, height: 1440 },
	{ bitrate: 19_400_000, width: 3840, height: 2160 },
];

// A constant quality ladder of a simple video: 1080p carries fewer bits than
// 720p, so hls.js, which lists levels by bitrate, puts 1080p before 720p.
const UNEVEN_LADDER = [
	{ bitrate: 740_000, width: 640, height: 360, name: "360p" },
	{ bitrate: 2_300_000, width: 1920, height: 1080, name: "1080p" },
	{ bitrate: 4_800_000, width: 1280, height: 720, name: "720p" },
];

// A player as wide as `width`, judged on width alone.
const wide = (width: number) => ({ width, height: Number.POSITIVE_INFINITY });

const video = (nativeHls: boolean) =>
	({
		canPlayType: () => (nativeHls ? "maybe" : ""),
	}) as unknown as HTMLVideoElement;

const browser = (options: {
	vendor: string;
	mediaSource: boolean;
	managedOnly?: boolean;
	touchPoints?: number;
}) => {
	vi.stubGlobal("navigator", {
		vendor: options.vendor,
		maxTouchPoints: options.touchPoints ?? 0,
	});
	vi.stubGlobal("window", {
		...(options.mediaSource ? { MediaSource: class {} } : {}),
		...(options.managedOnly ? { ManagedMediaSource: class {} } : {}),
	});
};

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("offline"))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pickStartingLevel", () => {
	it("starts at the lowest rendition on a slow connection", () => {
		expect(pickStartingLevel(LADDER, wide(1920), 1_400_000)).toBe(0);
	});

	it("stops at the first rendition that covers the player", () => {
		expect(pickStartingLevel(LADDER, wide(1408), 8_000_000)).toBe(2);
		expect(pickStartingLevel(LADDER, wide(600), 50_000_000)).toBe(0);
		expect(pickStartingLevel(LADDER, wide(1280), 50_000_000)).toBe(1);
	});

	it("counts a rendition as covering when it is as tall as the player", () => {
		expect(
			pickStartingLevel(LADDER, { width: 5000, height: 700 }, 50_000_000),
		).toBe(1);
	});

	it("never picks a rendition the connection cannot carry", () => {
		expect(pickStartingLevel(LADDER, wide(3840), 8_000_000)).toBe(2);
		expect(pickStartingLevel(LADDER, wide(3840), 50_000_000)).toBe(4);
	});

	it("starts a 1136 by 639 player on 720p with the default estimate", () => {
		expect(
			pickStartingLevel(LADDER, { width: 1136, height: 639 }, 5_000_000),
		).toBe(1);
	});

	it("chooses by resolution when bitrate does not rise with it", () => {
		const player = { width: 1136, height: 639 };
		expect(pickStartingLevel(UNEVEN_LADDER, player, 5_000_000)).toBe(2);
		expect(pickStartingLevel(UNEVEN_LADDER, player, 3_000_000)).toBe(0);
		expect(
			pickStartingLevel(
				UNEVEN_LADDER,
				{ width: 1920, height: 1080 },
				5_000_000,
			),
		).toBe(1);
		expect(pickStartingLevel(UNEVEN_LADDER, wide(600), 50_000_000)).toBe(0);
	});

	it("handles a single rendition and an empty ladder", () => {
		expect(pickStartingLevel(LADDER.slice(0, 1), wide(3840), 50_000_000)).toBe(
			0,
		);
		expect(pickStartingLevel([], wide(3840), 50_000_000)).toBe(0);
	});
});

describe("isSharper", () => {
	it("compares resolution, not the order hls.js lists levels in", () => {
		expect(isSharper(UNEVEN_LADDER, 1, 2)).toBe(true);
		expect(isSharper(UNEVEN_LADDER, 2, 1)).toBe(false);
		expect(isSharper(UNEVEN_LADDER, 2, 0)).toBe(true);
		expect(isSharper(UNEVEN_LADDER, 1, 1)).toBe(false);
		expect(isSharper(UNEVEN_LADDER, 0, -1)).toBe(true);
	});
});

describe("listLevels", () => {
	it("lists the quality menu by resolution when bitrate does not rise with it", () => {
		expect(listLevels(UNEVEN_LADDER).map((level) => level.label)).toEqual([
			"1080p",
			"720p",
			"360p",
		]);
		expect(listLevels(UNEVEN_LADDER).map((level) => level.index)).toEqual([
			1, 2, 0,
		]);
	});
});

describe("startingEstimate", () => {
	const hint = (connection?: object) =>
		vi.stubGlobal("navigator", { vendor: "", connection });

	it("assumes a line for the player's rendition when there is no hint", () => {
		hint();
		expect(startingEstimate()).toBe(5_000_000);
	});

	it("takes the browser's reading, never above the default", () => {
		hint({ downlink: 1.6, effectiveType: "4g" });
		expect(startingEstimate()).toBe(1_280_000);
		hint({ downlink: 0.4 });
		expect(startingEstimate()).toBe(320_000);
		hint({ downlink: 10, effectiveType: "4g" });
		expect(startingEstimate()).toBe(5_000_000);
		hint({ effectiveType: "3g", downlink: 10 });
		expect(startingEstimate()).toBe(5_000_000);
	});

	it("starts low on a slow line with no reading, and with data saver", () => {
		hint({ effectiveType: "slow-2g" });
		expect(startingEstimate()).toBe(500_000);
		hint({ effectiveType: "4g" });
		expect(startingEstimate()).toBe(5_000_000);
		hint({ saveData: true, downlink: 10 });
		expect(startingEstimate()).toBe(500_000);
	});
});

describe("pickPlaybackMode", () => {
	const both = { hls: "/film/master.m3u8", mp4: "/film/video.mp4" };

	it("runs hls.js in Safari on a Mac", () => {
		browser({ vendor: "Apple Computer, Inc.", mediaSource: true });
		expect(pickPlaybackMode(video(true), both)).toBe("mse");
	});

	it("plays HLS natively on an iPhone, which has only a managed media source", () => {
		browser({
			vendor: "Apple Computer, Inc.",
			mediaSource: false,
			managedOnly: true,
			touchPoints: 5,
		});
		expect(pickPlaybackMode(video(true), both)).toBe("native");
	});

	it("plays HLS natively on an iPad, which has a media source and touch", () => {
		browser({
			vendor: "Apple Computer, Inc.",
			mediaSource: true,
			touchPoints: 5,
		});
		expect(pickPlaybackMode(video(true), both)).toBe("native");
	});

	it("uses media source extensions elsewhere, even when native HLS is claimed", () => {
		browser({ vendor: "Google Inc.", mediaSource: true });
		expect(pickPlaybackMode(video(false), both)).toBe("mse");
		expect(pickPlaybackMode(video(true), both)).toBe("mse");
	});

	it("uses native HLS when there is no media source support", () => {
		browser({ vendor: "", mediaSource: false });
		expect(pickPlaybackMode(video(true), both)).toBe("native");
	});

	it("falls back to the file, then to nothing", () => {
		browser({ vendor: "", mediaSource: false });
		expect(pickPlaybackMode(video(false), both)).toBe("file");
		expect(pickPlaybackMode(video(false), { hls: both.hls })).toBe("none");
		expect(pickPlaybackMode(video(false), { mp4: both.mp4 })).toBe("file");
		expect(pickPlaybackMode(video(false), {})).toBe("none");
	});
});

class FakeVideo extends EventTarget {
	playbackRate = 1;
	preload = "none";
	src = "";
	paused = true;
	muted = false;
	currentTime = 0;
	duration = Number.NaN;
	clientWidth = 1280;
	clientHeight = 720;
	plays = 0;
	refusals: string[] = [];

	constructor(private readonly nativeHls: boolean) {
		super();
	}

	canPlayType() {
		return this.nativeHls ? "maybe" : "";
	}

	play() {
		this.plays++;
		const refusal = this.refusals.shift();
		if (refusal) {
			const error = new Error("refused");
			error.name = refusal;
			return Promise.reject(error);
		}
		this.paused = false;
		this.dispatchEvent(new Event("play"));
		return Promise.resolve();
	}

	load() {}

	removeAttribute(name: string) {
		if (name === "src") this.src = "";
	}

	reach(duration: number) {
		this.duration = duration;
		this.dispatchEvent(new Event("loadedmetadata"));
	}
}

const HLS = "https://media.example/film/master.m3u8";
const MP4 = "https://media.example/film/video.mp4";
const SHORT_HLS = `${HLS}?segments=short`;
const PLAYED_HLS = `${HLS}?subtitles=none`;
const PLAYED_SHORT_HLS = `${PLAYED_HLS}&segments=short`;
const LADDER_DATA = { levels: LADDER };

const page = (options: {
	vendor: string;
	mediaSource: boolean;
	loaded: boolean;
	touchPoints?: number;
	megabits?: number;
	effectiveType?: string;
}) => {
	const view = new EventTarget();
	Object.assign(view, { devicePixelRatio: 1 });
	if (options.mediaSource) Object.assign(view, { MediaSource: class {} });
	vi.stubGlobal("window", view);
	vi.stubGlobal("navigator", {
		vendor: options.vendor,
		maxTouchPoints: options.touchPoints ?? 0,
		...(options.megabits || options.effectiveType
			? {
					connection: {
						downlink: options.megabits,
						effectiveType: options.effectiveType,
					},
				}
			: {}),
	});
	const doc = { readyState: options.loaded ? "complete" : "loading" };
	vi.stubGlobal("document", doc);
	return {
		finishLoading: () => {
			doc.readyState = "complete";
			view.dispatchEvent(new Event("load"));
		},
	};
};

const iphone = (loaded = false) =>
	page({
		vendor: "Apple Computer, Inc.",
		mediaSource: false,
		loaded,
		touchPoints: 5,
	});
const macSafari = (loaded = false) =>
	page({ vendor: "Apple Computer, Inc.", mediaSource: true, loaded });
const chrome = (loaded = false) =>
	page({ vendor: "Google Inc.", mediaSource: true, loaded, megabits: 10 });

const attach = (
	video: FakeVideo,
	source: { hls?: string; mp4?: string },
	options: { autoPlay?: boolean; startAt?: number } = {},
) => {
	const onFatal = vi.fn();
	const onLevels = vi.fn();
	const attached = attachSource(video as unknown as HTMLVideoElement, source, {
		autoPlay: options.autoPlay ?? false,
		startAt: options.startAt,
		onFatal,
		onLevels,
	});
	return { ...attached, onFatal, onLevels };
};

const hlsFor = async () => {
	await vi.dynamicImportSettled();
	const hls = hlsMock.FakeHls.instances.at(-1);
	if (!hls) throw new Error("hls.js was not started");
	return hls;
};

describe("startWithin", () => {
	it("keeps a start time inside the video", () => {
		expect(startWithin(30, 120)).toBe(30);
		expect(startWithin(119.5, 120)).toBe(119.5);
	});

	it("ignores a start time at or past the end, or before the duration is known", () => {
		expect(startWithin(120, 120)).toBe(0);
		expect(startWithin(500, 120)).toBe(0);
		expect(startWithin(30, Number.NaN)).toBe(0);
		expect(startWithin(30, Number.POSITIVE_INFINITY)).toBe(0);
		expect(startWithin(0, 120)).toBe(0);
	});
});

describe("playAllowingMuted", () => {
	it("plays with sound when the browser allows it", async () => {
		const video = new FakeVideo(false);

		await playAllowingMuted(video);

		expect(video.paused).toBe(false);
		expect(video.muted).toBe(false);
		expect(video.plays).toBe(1);
	});

	it("starts muted when the browser refuses sound", async () => {
		const video = new FakeVideo(false);
		video.refusals = ["NotAllowedError"];

		await playAllowingMuted(video);

		expect(video.paused).toBe(false);
		expect(video.muted).toBe(true);
		expect(video.plays).toBe(2);
	});

	it("stays paused with its sound when the browser refuses any autoplay", async () => {
		const video = new FakeVideo(false);
		video.refusals = ["NotAllowedError", "NotAllowedError"];

		await expect(playAllowingMuted(video)).resolves.toBeUndefined();

		expect(video.paused).toBe(true);
		expect(video.muted).toBe(false);
	});

	it("does not ask twice when it was already muted", async () => {
		const video = new FakeVideo(false);
		video.muted = true;
		video.refusals = ["NotAllowedError"];

		await expect(playAllowingMuted(video)).resolves.toBeUndefined();

		expect(video.plays).toBe(1);
		expect(video.muted).toBe(true);
	});

	it("does not mute over an interrupted load", async () => {
		const video = new FakeVideo(false);
		video.refusals = ["AbortError"];

		await expect(playAllowingMuted(video)).resolves.toBeUndefined();

		expect(video.plays).toBe(1);
		expect(video.muted).toBe(false);
	});
});

describe("attachSource before play", () => {
	it("loads nothing on an iPhone until the document has loaded, then only metadata", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });

		expect(video.src).toBe(PLAYED_HLS);
		expect(video.preload).toBe("none");

		finishLoading();

		expect(video.preload).toBe("metadata");
		expect(video.plays).toBe(0);
	});

	it("reads metadata at once when the document has already loaded", () => {
		iphone(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS });

		expect(video.preload).toBe("metadata");
	});

	it("uses the browser's own HLS where there is no media source at all", () => {
		page({ vendor: "", mediaSource: false, loaded: true });
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });

		expect(video.src).toBe(PLAYED_HLS);
		expect(video.preload).toBe("metadata");
	});

	it("treats the MP4 the same way", () => {
		const { finishLoading } = page({
			vendor: "",
			mediaSource: false,
			loaded: false,
		});
		const video = new FakeVideo(false);

		attach(video, { mp4: MP4 });

		expect(video.src).toBe(MP4);
		expect(video.preload).toBe("none");

		finishLoading();

		expect(video.preload).toBe("metadata");
	});

	it("holds autoplay until the document has loaded", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { autoPlay: true });

		expect(video.plays).toBe(0);

		finishLoading();

		expect(video.plays).toBe(1);
	});

	it("leaves a video the viewer already started alone", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS });
		void video.play();
		finishLoading();

		expect(video.preload).toBe("none");
		expect(video.plays).toBe(1);
	});

	it("stops waiting for the document when it is detached", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		const { stop } = attach(video, { hls: HLS }, { autoPlay: true });
		stop();
		finishLoading();

		expect(video.src).toBe("");
		expect(video.preload).toBe("none");
		expect(video.plays).toBe(0);
	});

	it("falls back to the MP4, still without preloading, when native HLS fails", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		const { onFatal } = attach(video, { hls: HLS, mp4: MP4 });
		video.dispatchEvent(new Event("error"));

		expect(video.src).toBe(MP4);
		expect(video.preload).toBe("none");
		expect(onFatal).not.toHaveBeenCalled();

		finishLoading();

		expect(video.preload).toBe("metadata");

		video.dispatchEvent(new Event("error"));

		expect(onFatal).toHaveBeenCalledTimes(1);
	});

	it("reports a source it cannot play at all", () => {
		page({ vendor: "", mediaSource: false, loaded: true });
		const video = new FakeVideo(false);

		const { onFatal } = attach(video, { hls: HLS });

		expect(onFatal).toHaveBeenCalledTimes(1);
		expect(video.src).toBe("");
	});
});

describe("attachSource warm-up on intent", () => {
	it("lets an iPhone load ahead once the document has loaded", () => {
		const { finishLoading } = iphone();
		const video = new FakeVideo(true);

		const { warm } = attach(video, { hls: HLS, mp4: MP4 });
		warm();

		expect(video.preload).toBe("none");

		finishLoading();
		warm();

		expect(video.preload).toBe("auto");
	});

	it("leaves a playing video alone", () => {
		iphone(true);
		const video = new FakeVideo(true);

		const { warm } = attach(video, { hls: HLS });
		void video.play();
		warm();

		expect(video.preload).toBe("metadata");
	});

	it("never lifts the MP4 above metadata", () => {
		iphone(true);
		const fallback = new FakeVideo(true);
		const file = new FakeVideo(false);
		page({ vendor: "", mediaSource: false, loaded: true });

		const direct = attach(file, { mp4: MP4 });
		direct.warm();

		expect(file.preload).toBe("metadata");

		iphone(true);
		const native = attach(fallback, { hls: HLS, mp4: MP4 });
		fallback.dispatchEvent(new Event("error"));
		native.warm();

		expect(fallback.src).toBe(MP4);
		expect(fallback.preload).toBe("metadata");
	});

	it("does nothing with hls.js, which already holds one segment", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		const { warm } = attach(video, { hls: HLS });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		warm();

		expect(video.preload).toBe("auto");
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);
	});

	it("does nothing once detached", () => {
		iphone(true);
		const video = new FakeVideo(true);

		const { stop, warm } = attach(video, { hls: HLS });
		stop();
		video.preload = "none";
		warm();

		expect(video.preload).toBe("none");
	});
});

describe("attachSource start time", () => {
	it("seeks to the start time once the duration is known", () => {
		iphone(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { startAt: 30 });
		video.reach(120);

		expect(video.currentTime).toBe(30);
	});

	it("ignores a start time past the end", () => {
		iphone(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { startAt: 300 });
		video.reach(120);

		expect(video.currentTime).toBe(0);
	});

	it("seeks only once, so a later reload keeps the viewer's place", () => {
		iphone(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { startAt: 30 });
		video.reach(120);
		video.currentTime = 80;
		video.reach(120);

		expect(video.currentTime).toBe(80);
	});
});

describe("attachSource with hls.js", () => {
	it("fetches the playlists and one segment of one rendition until play", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS, mp4: MP4 });
		const hls = await hlsFor();

		expect(video.preload).toBe("auto");
		expect(hls.source).toBe(PLAYED_SHORT_HLS);
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);
		expect(hls.startLoads).toEqual([]);

		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });

		expect(hls.startLevel).toBe(1);
		expect(hls.loadLevel).toBe(1);
		expect(hls.startLoads).toEqual([-1]);
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);
		expect(SECONDS_AHEAD_BEFORE_PLAY).toBeLessThan(2);
	});

	it("buffers freely and adapts again once play is pressed", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });
		void video.play();

		expect(hls.config.maxMaxBufferLength).toBe(600);
		expect(hls.loadLevel).toBe(-1);
		expect(hls.startLoads).toEqual([-1]);
	});

	it("never holds back a video that autoplays", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS }, { autoPlay: true });
		const hls = await hlsFor();

		expect(video.plays).toBe(1);
		expect(hls.config.maxMaxBufferLength).toBe(600);

		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });

		expect(hls.startLevel).toBe(1);
		expect(hls.loadLevel).toBe(-1);
		expect(hls.config.maxMaxBufferLength).toBe(600);
		expect(hls.startLoads).toEqual([-1]);
	});

	it("does not hold back a video the viewer started before hls.js arrived", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS });
		void video.play();
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);

		expect(hls.config.maxMaxBufferLength).toBe(600);
		expect(hls.loadLevel).toBe(-1);
	});

	it("loads from the start time and leaves the seek to hls.js", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS }, { startAt: 45 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });

		expect(hls.startLoads).toEqual([45]);

		video.reach(120);

		expect(video.currentTime).toBe(0);
	});

	it("goes back to the beginning when the start time is past the end", async () => {
		chrome();
		const video = new FakeVideo(false);

		attach(video, { hls: HLS }, { startAt: 450 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });

		expect(hls.startLoads).toEqual([450, 0]);
	});

	it("moves to the MP4 on a fatal error and stops steering hls.js", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		const { onFatal } = attach(video, { hls: HLS, mp4: MP4 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("error", { fatal: true, type: "networkError" });

		expect(hls.destroyed).toBe(true);
		expect(video.src).toBe(MP4);
		expect(video.preload).toBe("metadata");
		expect(onFatal).not.toHaveBeenCalled();

		void video.play();

		expect(hls.loadLevel).toBe(1);
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);
	});

	it("carries the start time into the MP4 when HLS fails before it starts", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		attach(video, { hls: HLS, mp4: MP4 }, { startAt: 45 });
		const hls = await hlsFor();
		hls.emit("error", { fatal: true, type: "networkError" });
		video.reach(120);

		expect(video.src).toBe(MP4);
		expect(video.currentTime).toBe(45);
	});

	it("carries the start time into the MP4 when HLS fails after its playlists loaded", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		attach(video, { hls: HLS, mp4: MP4 }, { startAt: 45 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });
		hls.emit("error", { fatal: true, type: "networkError" });
		video.reach(120);

		expect(video.src).toBe(MP4);
		expect(video.currentTime).toBe(45);
	});

	it("does not repeat the start time in the MP4 once HLS has reached it", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		attach(video, { hls: HLS, mp4: MP4 }, { startAt: 45 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });
		video.dispatchEvent(new Event("seeked"));
		hls.emit("error", { fatal: true, type: "networkError" });
		video.reach(120);

		expect(video.src).toBe(MP4);
		expect(video.currentTime).toBe(0);
	});

	it("does not send the MP4 to a start time past the end", async () => {
		chrome(true);
		const video = new FakeVideo(false);

		attach(video, { hls: HLS, mp4: MP4 }, { startAt: 450 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });
		hls.emit("error", { fatal: true, type: "networkError" });
		video.reach(120);

		expect(video.currentTime).toBe(0);
	});

	it("holds Safari on a Mac to one segment like any other hls.js browser", async () => {
		macSafari();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);

		expect(video.src).toBe("");
		expect(hls.source).toBe(PLAYED_SHORT_HLS);
		expect(hls.config).toMatchObject({ preferManagedMediaSource: false });
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);
		expect(hls.loadLevel).toBe(hls.startLevel);
		expect(hls.startLoads).toEqual([-1]);
	});

	it("starts on the rendition that fits when the browser gives no connection estimate", async () => {
		macSafari();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);

		expect(hls.startLevel).toBe(1);
		expect(hls.config.abrEwmaDefaultEstimate).toBe(5_000_000);
	});

	it("hands a fatal hls.js error in Safari to its own HLS player, then to the MP4", async () => {
		macSafari(true);
		const video = new FakeVideo(true);

		const { onFatal, onLevels, warm } = attach(video, {
			hls: HLS,
			mp4: MP4,
		});
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);

		expect(onLevels).toHaveBeenCalledTimes(1);

		hls.emit("error", { fatal: true, type: "networkError" });

		expect(onLevels).toHaveBeenCalledTimes(2);
		expect(onLevels).toHaveBeenLastCalledWith([]);
		expect(hls.destroyed).toBe(true);
		expect(video.src).toBe(PLAYED_HLS);
		expect(video.preload).toBe("metadata");
		expect(video.plays).toBe(0);

		warm();

		expect(video.preload).toBe("auto");

		video.dispatchEvent(new Event("error"));

		expect(video.src).toBe(MP4);
		expect(onFatal).not.toHaveBeenCalled();

		video.dispatchEvent(new Event("error"));

		expect(onFatal).toHaveBeenCalledTimes(1);
	});

	it("keeps the viewer's place and keeps playing when Safari's own player takes over", async () => {
		macSafari(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		void video.play();
		video.currentTime = 30;
		hls.emit("error", { fatal: true, type: "networkError" });

		expect(video.src).toBe(PLAYED_HLS);
		expect(video.currentTime).toBe(30);
		expect(video.plays).toBe(2);
	});

	it("carries the start time into Safari's own player when hls.js fails before reaching it", async () => {
		macSafari(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 }, { startAt: 45 });
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		hls.emit("levelLoaded", { details: { totalduration: 120 } });
		hls.emit("error", { fatal: true, type: "networkError" });
		video.reach(120);

		expect(video.src).toBe(PLAYED_HLS);
		expect(video.currentTime).toBe(45);
	});

	it("starts Safari's own player when hls.js cannot run", async () => {
		macSafari(true);
		const video = new FakeVideo(true);
		const supported = hlsMock.FakeHls.isSupported;
		hlsMock.FakeHls.isSupported = () => false;
		const before = hlsMock.FakeHls.instances.length;

		attach(video, { hls: HLS, mp4: MP4 });
		await vi.dynamicImportSettled();
		hlsMock.FakeHls.isSupported = supported;

		expect(hlsMock.FakeHls.instances).toHaveLength(before);
		expect(video.src).toBe(PLAYED_HLS);
		expect(video.preload).toBe("metadata");
	});

	it("sends a browser that only claims HLS straight to the MP4", async () => {
		chrome(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });
		const hls = await hlsFor();
		hls.emit("error", { fatal: true, type: "networkError" });

		expect(video.src).toBe(MP4);
	});

	it("releases hls.js when it is detached", async () => {
		chrome();
		const video = new FakeVideo(false);

		const { stop } = attach(video, { hls: HLS });
		const hls = await hlsFor();
		stop();

		expect(hls.destroyed).toBe(true);
	});
});

describe("withShortPlaylists", () => {
	it("asks for the short form and keeps any other query", () => {
		vi.stubGlobal("document", { baseURI: "https://cap.so/dev/abc/embed" });

		expect(withShortPlaylists(HLS)).toBe(SHORT_HLS);
		expect(withShortPlaylists(`${HLS}?token=1`)).toBe(
			`${HLS}?token=1&segments=short`,
		);
		expect(withShortPlaylists(`${HLS}?segments=long`)).toBe(SHORT_HLS);
		expect(withShortPlaylists("/api/developer/playback/abc/master.m3u8")).toBe(
			"https://cap.so/api/developer/playback/abc/master.m3u8?segments=short",
		);
	});

	it("keeps the plain playlist for Safari's own player and the MP4", () => {
		iphone(true);
		const native = new FakeVideo(true);
		attach(native, { hls: HLS, mp4: MP4 });

		expect(native.src).toBe(PLAYED_HLS);

		native.dispatchEvent(new Event("error"));

		expect(native.src).toBe(MP4);
	});
});

describe("attachSource switching to the rendition that fits", () => {
	type Hls = InstanceType<typeof hlsMock.FakeHls>;

	// Chrome's reading of about 1.6 Mbps, on a fast line or a slow one, so the
	// player starts on the lowest rendition until it has measured the line.
	const lowEstimate = () =>
		page({
			vendor: "Google Inc.",
			mediaSource: true,
			loaded: true,
			megabits: 1.6,
		});

	const countSeeks = (video: FakeVideo) => {
		let seeks = 0;
		let time = 0;
		Object.defineProperty(video, "currentTime", {
			get: () => time,
			set: (value: number) => {
				seeks++;
				time = value;
			},
		});
		return () => seeks;
	};

	const held = (hls: Hls, level = 0) =>
		hls.emit("fragBuffered", { frag: { type: "main", level, duration: 4 } });

	// The bandwidth at which the 1280 wide rendition's 4 second segment
	// arrives in exactly the time allowed.
	const JUST_FAST_ENOUGH = (LADDER[1]?.bitrate ?? 0) * (4 / SECONDS_TO_SHARPEN);

	const started = async (
		video: FakeVideo,
		options: { startAt?: number } = {},
	) => {
		const attached = attach(video, { hls: HLS }, options);
		const hls = await hlsFor();
		hls.emit("manifestParsed", LADDER_DATA);
		return { ...attached, hls };
	};

	it("fetches nothing more before play and switches as playback starts", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const seeks = countSeeks(video);
		const { hls } = await started(video);

		expect(hls.loadLevel).toBe(0);

		hls.bandwidthEstimate = JUST_FAST_ENOUGH;
		held(hls);

		expect(hls.currentLevel).toBe(-1);
		expect(hls.loadLevel).toBe(0);
		expect(hls.config.maxMaxBufferLength).toBe(SECONDS_AHEAD_BEFORE_PLAY);

		void video.play();

		expect(hls.currentLevel).toBe(1);
		expect(seeks()).toBe(0);

		hls.loadLevel = 1;
		held(hls, 1);

		expect(seeks()).toBe(1);
		expect(video.currentTime).toBe(0);
		expect(hls.loadLevel).toBe(-1);

		held(hls, 1);

		expect(seeks()).toBe(1);
	});

	it("switches as soon as the first segment arrives when already playing", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		hls.bandwidthEstimate = 1_000_000_000;
		void video.play();
		held(hls);

		expect(hls.currentLevel).toBe(1);
	});

	it("never switches above the rendition that fits the player", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		void video.play();

		expect(hls.currentLevel).toBe(1);
	});

	it("keeps the first segment when the line could not fetch a sharper one in time", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		hls.bandwidthEstimate = JUST_FAST_ENOUGH - 1;
		held(hls);
		void video.play();

		expect(hls.currentLevel).toBe(-1);
	});

	it("keeps a first segment that already fits", async () => {
		chrome(true);
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		expect(hls.loadLevel).toBe(1);

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls, 1);
		void video.play();

		expect(hls.currentLevel).toBe(-1);
	});

	it("only measures video segments", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		hls.bandwidthEstimate = 1_000_000_000;
		hls.emit("fragBuffered", {
			frag: { type: "audio", level: 0, duration: 4 },
		});
		void video.play();

		expect(hls.currentLevel).toBe(-1);
	});

	it("measures the line once", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video);

		hls.bandwidthEstimate = JUST_FAST_ENOUGH - 1;
		held(hls);
		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		void video.play();

		expect(hls.currentLevel).toBe(-1);
	});

	it("leaves a quality the viewer picked alone", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls, setLevel } = await started(video);

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		setLevel(3);
		void video.play();

		expect(hls.currentLevel).toBe(-1);
	});

	it("switches once hls.js has reached a start time", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls } = await started(video, { startAt: 45 });

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		void video.play();

		expect(hls.currentLevel).toBe(-1);

		video.dispatchEvent(new Event("seeked"));

		expect(hls.currentLevel).toBe(1);
	});

	it("drops a waiting switch when the viewer picks a quality", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		const { hls, setLevel } = await started(video, { startAt: 45 });

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		void video.play();
		setLevel(3);
		video.dispatchEvent(new Event("seeked"));

		expect(hls.currentLevel).toBe(-1);
	});

	it("switches by resolution when bitrate does not rise with it", async () => {
		lowEstimate();
		const video = new FakeVideo(false);
		attach(video, { hls: HLS });
		const hls = await hlsFor();
		hls.emit("manifestParsed", { levels: UNEVEN_LADDER });

		expect(hls.loadLevel).toBe(0);

		hls.bandwidthEstimate = 1_000_000_000;
		held(hls);
		void video.play();

		expect(hls.currentLevel).toBe(2);
	});
});

const MASTER = [
	"#EXTM3U",
	"#EXT-X-VERSION:7",
	'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio",DEFAULT=YES,URI="audio.m3u8"',
	'#EXT-X-STREAM-INF:BANDWIDTH=2501452,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"',
	"720p.m3u8",
	'#EXT-X-STREAM-INF:BANDWIDTH=4573338,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"',
	"1080p.m3u8",
	'#EXT-X-STREAM-INF:BANDWIDTH=739748,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_aud"',
	"360p.m3u8",
	"",
].join("\n");

describe("native HLS renditions", () => {
	it("reads Cap's renditions from a master playlist", () => {
		expect(parseMasterLevels(MASTER)).toEqual([
			{ width: 1280, height: 720, bitrate: 2501452, uri: "720p.m3u8" },
			{ width: 1920, height: 1080, bitrate: 4573338, uri: "1080p.m3u8" },
			{ width: 640, height: 360, bitrate: 739748, uri: "360p.m3u8" },
		]);
		expect(
			listLevels(parseMasterLevels(MASTER)).map((level) => level.label),
		).toEqual(["1080p", "720p", "360p"]);
	});

	it("orders the menu by height when bandwidth does not rise with it", () => {
		iphone(true);
		const uneven = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=3840x2160,AUDIO="aud"',
			"2160p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1920x1080,AUDIO="aud"',
			"1080p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=1900000,RESOLUTION=1280x720,AUDIO="aud"',
			"720p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"',
			"360p.m3u8",
		].join("\n");
		const levels = parseMasterLevels(uneven);
		const menu = listLevels(levels);

		expect(menu.map((level) => level.label)).toEqual([
			"4K",
			"1080p",
			"720p",
			"360p",
		]);
		const picked = menu.find((level) => level.label === "1080p");
		expect(renditionSource(HLS, levels[picked?.index ?? -1]?.uri)).toBe(
			`${HLS}?rendition=1080p`,
		);
	});

	it("lists native renditions in the same order and labels as hls.js does", () => {
		iphone(true);
		const uneven = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=1900000,RESOLUTION=1280x720,AUDIO="aud"',
			"720p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1920x1080,AUDIO="aud"',
			"1080p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"',
			"360p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=3840x2160,AUDIO="aud"',
			"2160p.m3u8",
		].join("\n");
		const native = listLevels(parseMasterLevels(uneven));
		const hlsJs = listLevels(
			[...parseMasterLevels(uneven)]
				.sort((a, b) => a.bitrate - b.bitrate)
				.map(({ width, height, bitrate, uri }) => ({
					width,
					height,
					bitrate,
					name: uri.replace(".m3u8", ""),
				})),
		);

		expect(native.map((level) => level.label)).toEqual([
			"4K",
			"1080p",
			"720p",
			"360p",
		]);
		expect(native.map((level) => level.label)).toEqual(
			hlsJs.map((level) => level.label),
		);
	});

	it("skips variants that are not Cap renditions", () => {
		const odd = [
			"#EXTM3U",
			"#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720",
			"https://elsewhere.example/720p.m3u8",
			"#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720",
			"../720p.m3u8",
			"#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720",
			"#EXT-X-ENDLIST",
		].join("\n");

		expect(parseMasterLevels(odd)).toEqual([]);
		expect(parseMasterLevels("")).toEqual([]);
	});

	it("points a picked rendition at a master that lists only it", () => {
		iphone(true);
		expect(renditionSource(HLS, "720p.m3u8")).toBe(`${HLS}?rendition=720p`);
		expect(renditionSource(`${HLS}?max=1080`, "720p.m3u8")).toBe(
			`${HLS}?max=1080&rendition=720p`,
		);
		expect(renditionSource(HLS, "720p.m3u8?segments=short")).toBe(
			`${HLS}?rendition=720p`,
		);
		expect(renditionSource(HLS, "audio.m3u8")).toBeNull();
		expect(renditionSource(HLS, undefined)).toBeNull();
	});

	const nativePlayer = async () => {
		iphone(true);
		const fetchMaster = vi.fn(async (_url: string) => new Response(MASTER));
		vi.stubGlobal("fetch", fetchMaster);
		const video = new FakeVideo(true);
		const attached = attach(video, { hls: HLS, mp4: MP4 });
		expect(fetchMaster).not.toHaveBeenCalled();
		video.reach(30);
		await vi.waitFor(() => expect(attached.onLevels).toHaveBeenCalledTimes(2));
		const levels = attached.onLevels.mock.calls[1]?.[0] as ReturnType<
			typeof listLevels
		>;
		const index = (label: string) => {
			const level = levels.find((entry) => entry.label === label);
			if (!level) throw new Error(`no ${label}`);
			return level.index;
		};
		return { video, fetchMaster, index, ...attached };
	};

	it("lists the renditions once the metadata is in, from the same master", async () => {
		const { fetchMaster, onLevels } = await nativePlayer();

		expect(fetchMaster).toHaveBeenCalledTimes(1);
		expect(fetchMaster.mock.calls[0]?.[0]).toBe(PLAYED_HLS);
		expect(
			(onLevels.mock.calls[1]?.[0] as { label: string }[]).map(
				(level) => level.label,
			),
		).toEqual(["1080p", "720p", "360p"]);
	});

	it("switches to a picked rendition and keeps the time and play state", async () => {
		const { video, setLevel, index } = await nativePlayer();
		await video.play();
		video.currentTime = 12.5;

		setLevel(index("720p"));

		expect(video.src).toBe(`${PLAYED_HLS}&rendition=720p`);
		expect(video.plays).toBe(2);
		video.currentTime = 0;
		video.reach(30);
		expect(video.currentTime).toBe(12.5);
	});

	it("keeps a paused video paused when it switches", async () => {
		const { video, setLevel, index } = await nativePlayer();
		video.currentTime = 4;

		setLevel(index("360p"));

		expect(video.src).toBe(`${PLAYED_HLS}&rendition=360p`);
		expect(video.plays).toBe(0);
	});

	it("goes back to the full master for Auto, and does nothing for the same pick", async () => {
		const { video, setLevel, index } = await nativePlayer();

		setLevel(AUTO_LEVEL);
		expect(video.src).toBe(PLAYED_HLS);

		setLevel(index("1080p"));
		expect(video.src).toBe(`${PLAYED_HLS}&rendition=1080p`);
		video.src = "changed-elsewhere";
		setLevel(index("1080p"));
		expect(video.src).toBe("changed-elsewhere");

		setLevel(AUTO_LEVEL);
		expect(video.src).toBe(PLAYED_HLS);
	});

	it("does not carry a switch's time over to a source attached after it stops", async () => {
		const { video, setLevel, index, stop } = await nativePlayer();
		video.currentTime = 9;

		setLevel(index("360p"));
		stop();
		video.currentTime = 0;
		video.reach(30);

		expect(video.currentTime).toBe(0);
	});

	it("keeps the place across picks made before the first switch has loaded", async () => {
		const { video, setLevel, index } = await nativePlayer();
		await video.play();
		video.currentTime = 12.5;

		setLevel(index("360p"));
		video.currentTime = 0;
		setLevel(index("1080p"));

		expect(video.src).toBe(`${PLAYED_HLS}&rendition=1080p`);
		expect(video.plays).toBe(3);
		video.reach(30);
		expect(video.currentTime).toBe(12.5);

		video.currentTime = 20;
		setLevel(AUTO_LEVEL);
		video.currentTime = 0;
		video.reach(30);
		expect(video.currentTime).toBe(20);
	});

	it("keeps a pause made while a switch loads through the next pick", async () => {
		const { video, setLevel, index } = await nativePlayer();
		await video.play();
		video.currentTime = 12.5;

		setLevel(index("360p"));
		expect(video.plays).toBe(2);
		video.currentTime = 0;
		video.paused = true;
		setLevel(index("1080p"));

		expect(video.plays).toBe(2);
		video.reach(30);
		expect(video.currentTime).toBe(12.5);
		expect(video.paused).toBe(true);
	});

	it("resumes a switch at a seek asked for while it loads", async () => {
		const { video, setLevel, index, seekDuringSwitch } = await nativePlayer();
		await video.play();
		video.currentTime = 12.5;

		expect(seekDuringSwitch(3)).toBe(false);
		setLevel(index("360p"));
		expect(seekDuringSwitch(18)).toBe(true);
		video.currentTime = 0;
		video.reach(30);

		expect(video.currentTime).toBe(18);
		expect(seekDuringSwitch(5)).toBe(false);
	});

	it("keeps a switch's place, and a seek asked for during it, when it falls back to the MP4", async () => {
		const { video, setLevel, index, seekDuringSwitch } = await nativePlayer();
		await video.play();
		video.currentTime = 12.5;

		setLevel(index("360p"));
		expect(seekDuringSwitch(18)).toBe(true);
		video.currentTime = 0;
		video.dispatchEvent(new Event("error"));

		expect(video.src).toBe(MP4);
		expect(video.currentTime).toBe(18);
		expect(seekDuringSwitch(5)).toBe(false);
	});

	it("keeps the playback speed across a quality switch", async () => {
		const { video, setLevel, index } = await nativePlayer();
		video.playbackRate = 1.5;
		const reset = Object.getOwnPropertyDescriptor(video, "src");
		let src = video.src;
		Object.defineProperty(video, "src", {
			get: () => src,
			set: (value: string) => {
				src = value;
				video.playbackRate = 1;
			},
			configurable: true,
		});

		setLevel(index("360p"));
		expect(video.playbackRate).toBe(1.5);
		video.playbackRate = 1;
		video.reach(30);
		expect(video.playbackRate).toBe(1.5);
		if (reset) Object.defineProperty(video, "src", reset);
	});

	it("ignores a pick it has no rendition for", async () => {
		const { video, setLevel } = await nativePlayer();

		setLevel(42);

		expect(video.src).toBe(PLAYED_HLS);
	});

	it("offers no menu when the master cannot be read", async () => {
		iphone(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);
		const video = new FakeVideo(true);
		const { onLevels } = attach(video, { hls: HLS });
		video.reach(30);
		await vi.waitFor(() => expect(onLevels).toHaveBeenCalledTimes(2));

		expect(onLevels.mock.calls[1]?.[0]).toEqual([]);
	});

	it("stops listing once detached", async () => {
		iphone(true);
		let release: (response: Response) => void = () => undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						release = resolve;
					}),
			),
		);
		const video = new FakeVideo(true);
		const { onLevels, stop } = attach(video, { hls: HLS });
		video.reach(30);
		stop();
		release(new Response(MASTER));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onLevels).toHaveBeenCalledTimes(1);
	});
});
