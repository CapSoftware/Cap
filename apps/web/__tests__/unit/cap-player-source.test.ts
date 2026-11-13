import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachSource,
	pickPlaybackMode,
	pickStartingLevel,
	playAllowingMuted,
	SECONDS_AHEAD_BEFORE_PLAY,
	startWithin,
} from "@/components/cap-player/source";

type Listener = (event: string, data: unknown) => void;

const hlsMock = vi.hoisted(() => {
	class FakeHls {
		static instances: FakeHls[] = [];
		static isSupported = () => true;
		static Events = {
			MANIFEST_PARSED: "manifestParsed",
			LEVEL_LOADED: "levelLoaded",
			ERROR: "error",
		};
		static ErrorTypes = { MEDIA_ERROR: "mediaError" };
		static DefaultConfig = { maxMaxBufferLength: 600 };

		config: { maxMaxBufferLength: number };
		startLevel = -1;
		loadLevel = -1;
		startLoads: number[] = [];
		source = "";
		destroyed = false;
		private listeners = new Map<string, Listener[]>();

		constructor(config: { maxMaxBufferLength: number }) {
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
	{ bitrate: 450_000, width: 640 },
	{ bitrate: 3_400_000, width: 1280 },
	{ bitrate: 6_650_000, width: 1920 },
	{ bitrate: 11_400_000, width: 2560 },
	{ bitrate: 19_400_000, width: 3840 },
];

const video = (nativeHls: boolean) =>
	({
		canPlayType: () => (nativeHls ? "maybe" : ""),
	}) as unknown as HTMLVideoElement;

const browser = (options: { vendor: string; mediaSource: boolean }) => {
	vi.stubGlobal("navigator", { vendor: options.vendor });
	vi.stubGlobal("window", options.mediaSource ? { MediaSource: class {} } : {});
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pickStartingLevel", () => {
	it("starts at the lowest rendition on a slow connection", () => {
		expect(pickStartingLevel(LADDER, 1920, 1_400_000)).toBe(0);
	});

	it("stops at the first rendition that covers the player", () => {
		expect(pickStartingLevel(LADDER, 1408, 8_000_000)).toBe(2);
		expect(pickStartingLevel(LADDER, 600, 50_000_000)).toBe(0);
		expect(pickStartingLevel(LADDER, 1280, 50_000_000)).toBe(1);
	});

	it("never picks a rendition the connection cannot carry", () => {
		expect(pickStartingLevel(LADDER, 3840, 8_000_000)).toBe(2);
		expect(pickStartingLevel(LADDER, 3840, 50_000_000)).toBe(4);
	});

	it("handles a single rendition and an empty ladder", () => {
		expect(pickStartingLevel(LADDER.slice(0, 1), 3840, 50_000_000)).toBe(0);
		expect(pickStartingLevel([], 3840, 50_000_000)).toBe(0);
	});
});

describe("pickPlaybackMode", () => {
	const both = { hls: "/film/master.m3u8", mp4: "/film/video.mp4" };

	it("plays HLS natively on Apple browsers", () => {
		browser({ vendor: "Apple Computer, Inc.", mediaSource: true });
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
	preload = "none";
	src = "";
	paused = true;
	muted = false;
	currentTime = 0;
	duration = Number.NaN;
	clientWidth = 1280;
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
const LADDER_DATA = { levels: LADDER };

const page = (options: {
	vendor: string;
	mediaSource: boolean;
	loaded: boolean;
}) => {
	const view = new EventTarget();
	Object.assign(view, { devicePixelRatio: 1 });
	if (options.mediaSource) Object.assign(view, { MediaSource: class {} });
	vi.stubGlobal("window", view);
	vi.stubGlobal("navigator", { vendor: options.vendor });
	const doc = { readyState: options.loaded ? "complete" : "loading" };
	vi.stubGlobal("document", doc);
	return {
		finishLoading: () => {
			doc.readyState = "complete";
			view.dispatchEvent(new Event("load"));
		},
	};
};

const safari = (loaded = false) =>
	page({ vendor: "Apple Computer, Inc.", mediaSource: true, loaded });
const chrome = (loaded = false) =>
	page({ vendor: "Google Inc.", mediaSource: true, loaded });

const attach = (
	video: FakeVideo,
	source: { hls?: string; mp4?: string },
	options: { autoPlay?: boolean; startAt?: number } = {},
) => {
	const onFatal = vi.fn();
	const attached = attachSource(video as unknown as HTMLVideoElement, source, {
		autoPlay: options.autoPlay ?? false,
		startAt: options.startAt,
		onFatal,
	});
	return { ...attached, onFatal };
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
	it("loads nothing in Safari until the document has loaded, then only metadata", () => {
		const { finishLoading } = safari();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS, mp4: MP4 });

		expect(video.src).toBe(HLS);
		expect(video.preload).toBe("none");

		finishLoading();

		expect(video.preload).toBe("metadata");
		expect(video.plays).toBe(0);
	});

	it("reads metadata at once when the document has already loaded", () => {
		safari(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS });

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
		const { finishLoading } = safari();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { autoPlay: true });

		expect(video.plays).toBe(0);

		finishLoading();

		expect(video.plays).toBe(1);
	});

	it("leaves a video the viewer already started alone", () => {
		const { finishLoading } = safari();
		const video = new FakeVideo(true);

		attach(video, { hls: HLS });
		void video.play();
		finishLoading();

		expect(video.preload).toBe("none");
		expect(video.plays).toBe(1);
	});

	it("stops waiting for the document when it is detached", () => {
		const { finishLoading } = safari();
		const video = new FakeVideo(true);

		const { stop } = attach(video, { hls: HLS }, { autoPlay: true });
		stop();
		finishLoading();

		expect(video.src).toBe("");
		expect(video.preload).toBe("none");
		expect(video.plays).toBe(0);
	});

	it("falls back to the MP4, still without preloading, when native HLS fails", () => {
		const { finishLoading } = safari();
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
	it("lets Safari load ahead once the document has loaded", () => {
		const { finishLoading } = safari();
		const video = new FakeVideo(true);

		const { warm } = attach(video, { hls: HLS, mp4: MP4 });
		warm();

		expect(video.preload).toBe("none");

		finishLoading();
		warm();

		expect(video.preload).toBe("auto");
	});

	it("leaves a playing video alone", () => {
		safari(true);
		const video = new FakeVideo(true);

		const { warm } = attach(video, { hls: HLS });
		void video.play();
		warm();

		expect(video.preload).toBe("metadata");
	});

	it("never lifts the MP4 above metadata", () => {
		safari(true);
		const fallback = new FakeVideo(true);
		const file = new FakeVideo(false);
		page({ vendor: "", mediaSource: false, loaded: true });

		const direct = attach(file, { mp4: MP4 });
		direct.warm();

		expect(file.preload).toBe("metadata");

		safari(true);
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
		safari(true);
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
		safari(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { startAt: 30 });
		video.reach(120);

		expect(video.currentTime).toBe(30);
	});

	it("ignores a start time past the end", () => {
		safari(true);
		const video = new FakeVideo(true);

		attach(video, { hls: HLS }, { startAt: 300 });
		video.reach(120);

		expect(video.currentTime).toBe(0);
	});

	it("seeks only once, so a later reload keeps the viewer's place", () => {
		safari(true);
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
		expect(hls.source).toBe(HLS);
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

	it("releases hls.js when it is detached", async () => {
		chrome();
		const video = new FakeVideo(false);

		const { stop } = attach(video, { hls: HLS });
		const hls = await hlsFor();
		stop();

		expect(hls.destroyed).toBe(true);
	});
});
