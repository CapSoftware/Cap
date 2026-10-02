import { describe, expect, it } from "vitest";
import {
	BROWSER_SAVE_CHUNK_FILE,
	browserSaveChunkKey,
	browserSaveMultivariantPlaylist,
	browserSavePlayable,
	browserSavePlaylist,
} from "@/lib/browser-save-chunks";

describe("browser save chunks", () => {
	it("accepts only the init segment and numbered media segments", () => {
		expect(BROWSER_SAVE_CHUNK_FILE.test("init.mp4")).toBe(true);
		expect(BROWSER_SAVE_CHUNK_FILE.test("segment-12.m4s")).toBe(true);
		expect(BROWSER_SAVE_CHUNK_FILE.test("../result.mp4")).toBe(false);
		expect(BROWSER_SAVE_CHUNK_FILE.test("segment-1.m4s/x")).toBe(false);
		expect(BROWSER_SAVE_CHUNK_FILE.test("segment-123456.m4s")).toBe(false);
	});

	it("keeps chunks inside the video's folder", () => {
		expect(browserSaveChunkKey("owner", "video", "save", "init.mp4")).toBe(
			"owner/video/.recording/browser-save/save/init.mp4",
		);
	});

	it("lists every uploaded segment after the init segment, still open", () => {
		const playlist = browserSavePlaylist("abc", "save", [2, 2.5], false);
		expect(playlist.split("\n")).toEqual([
			"#EXTM3U",
			"#EXT-X-VERSION:7",
			"#EXT-X-TARGETDURATION:4",
			"#EXT-X-PLAYLIST-TYPE:EVENT",
			'#EXT-X-MAP:URI="/api/videos/abc/browser-save/save/init.mp4"',
			"#EXTINF:2.000,",
			"/api/videos/abc/browser-save/save/segment-1.m4s",
			"#EXTINF:2.500,",
			"/api/videos/abc/browser-save/save/segment-2.m4s",
			"",
		]);
		expect(playlist).not.toContain("ENDLIST");
	});

	it("ends the playlist once the Save is done", () => {
		expect(browserSavePlaylist("abc", "save", [2], true)).toContain(
			"#EXT-X-ENDLIST\n",
		);
	});

	it("raises the target duration for a long segment", () => {
		expect(browserSavePlaylist("abc", "save", [6.2], false)).toContain(
			"#EXT-X-TARGETDURATION:7",
		);
	});

	it("starts playback after two chunks, as with 2 s chunks", () => {
		expect(browserSavePlayable([])).toBe(false);
		expect(browserSavePlayable([2])).toBe(false);
		expect(browserSavePlayable([2, 2])).toBe(true);
		expect(browserSavePlayable([1.9853, 2])).toBe(true);
		expect(browserSavePlayable([2, 0.05])).toBe(true);
	});

	it("starts playback once one longer chunk covers 4 s", () => {
		expect(browserSavePlayable([3.5])).toBe(false);
		expect(browserSavePlayable([4])).toBe(true);
		expect(browserSavePlayable([5])).toBe(true);
		expect(browserSavePlayable([10])).toBe(true);
	});

	it("wraps the media playlist in a multivariant playlist", () => {
		expect(browserSaveMultivariantPlaylist("abc").split("\n")).toEqual([
			"#EXTM3U",
			"#EXT-X-VERSION:7",
			"#EXT-X-STREAM-INF:BANDWIDTH=8000000",
			"/api/videos/abc/browser-save/playlist?media",
			"",
		]);
	});
});
