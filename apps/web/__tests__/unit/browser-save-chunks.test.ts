import { describe, expect, it } from "vitest";
import {
	BROWSER_SAVE_CHUNK_FILE,
	browserSaveChunkKey,
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
});
