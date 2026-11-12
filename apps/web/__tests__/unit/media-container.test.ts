import { describe, expect, it } from "vitest";
import { isSelfContainedMedia } from "@/lib/media-container";

const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => Uint8Array.from(values);
const withAscii = (prefix: number[], word: string, pad = 16) =>
	Uint8Array.from([
		...prefix,
		...text(word),
		...new Array<number>(pad).fill(0),
	]);

describe("self-contained media check", () => {
	it("accepts the containers a recording arrives in", () => {
		const accepted: [string, Uint8Array][] = [
			["mp4", withAscii([0, 0, 0, 0x20], "ftypisom")],
			["mov", withAscii([0, 0, 0, 0x14], "ftypqt  ")],
			["old quicktime", withAscii([0, 0, 0x10, 0], "moov")],
			["webm or mkv", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)],
			["wav", Uint8Array.from([...text("RIFF"), 1, 2, 3, 4, ...text("WAVE")])],
			["avi", Uint8Array.from([...text("RIFF"), 1, 2, 3, 4, ...text("AVI ")])],
			["aiff", Uint8Array.from([...text("FORM"), 1, 2, 3, 4, ...text("AIFF")])],
			["ogg", text("OggS\u0000\u0002")],
			["flac", text("fLaC\u0000")],
			["mp3 with a tag", text("ID3\u0004\u0000")],
			["mp3 frames", bytes(0xff, 0xfb, 0x90, 0x00)],
			["aac frames", bytes(0xff, 0xf1, 0x50, 0x80)],
			["amr", text("#!AMR\n")],
			["flv", text("FLV\u0001")],
			["caf", text("caff\u0000\u0001")],
		];
		for (const [name, sample] of accepted) {
			expect(isSelfContainedMedia(sample), name).toBe(true);
		}
		const ts = new Uint8Array(400);
		ts[0] = 0x47;
		ts[188] = 0x47;
		expect(isSelfContainedMedia(ts), "mpeg-ts").toBe(true);
		const m2ts = new Uint8Array(400);
		m2ts[4] = 0x47;
		m2ts[196] = 0x47;
		expect(isSelfContainedMedia(m2ts), "camcorder m2ts").toBe(true);
		expect(
			isSelfContainedMedia(bytes(0x00, 0x00, 0x01, 0xba, 0x44, 0x00)),
			"mpeg program stream",
		).toBe(true);
	});

	it("refuses playlists and other files that can point somewhere else", () => {
		const refused: [string, Uint8Array][] = [
			[
				"hls playlist",
				text("#EXTM3U\n#EXT-X-VERSION:3\nhttp://10.0.0.1/a.ts\n"),
			],
			["plain playlist", text("http://169.254.169.254/latest/meta-data/\n")],
			[
				"concat script",
				text("ffconcat version 1.0\nfile 'http://127.0.0.1/x'\n"),
			],
			["dash manifest", text('<?xml version="1.0"?><MPD></MPD>')],
			["smil", text("<smil><body></body></smil>")],
			["sdp", text("v=0\no=- 0 0 IN IP4 127.0.0.1\n")],
			["svg", text("<svg xmlns='http://www.w3.org/2000/svg'/>")],
			["html", text("<!doctype html><html></html>")],
			["json", text('{"url":"http://localhost"}')],
			[
				"riff that is not audio or video",
				Uint8Array.from([...text("RIFF"), 1, 2, 3, 4, ...text("WEBP")]),
			],
			["one stray sync byte", bytes(0x47, 0, 0, 0, 0)],
			["one stray m2ts sync byte", bytes(0, 0, 0, 0, 0x47, 0, 0, 0)],
			["mpeg start code that is not a pack", bytes(0x00, 0x00, 0x01, 0x00)],
			["too short", bytes(0x1a, 0x45)],
			["empty", new Uint8Array(0)],
		];
		for (const [name, sample] of refused) {
			expect(isSelfContainedMedia(sample), name).toBe(false);
		}
	});
});
