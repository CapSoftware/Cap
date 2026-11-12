import { afterEach, describe, expect, it, vi } from "vitest";
import {
	pickPlaybackMode,
	pickStartingLevel,
} from "@/components/cap-player/source";

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
