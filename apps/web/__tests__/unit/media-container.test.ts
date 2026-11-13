import { describe, expect, it } from "vitest";
import {
	isSelfContainedMedia,
	looksLikePlaylist,
	sniffMedia,
} from "@/lib/media-container";

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
		expect(
			isSelfContainedMedia(
				bytes(
					0x72,
					0x69,
					0x66,
					0x66,
					0x2e,
					0x91,
					0xcf,
					0x11,
					0xa5,
					0xd6,
					0x28,
					0xdb,
					0x04,
					0xc1,
					0x00,
					0x00,
					0x10,
				),
			),
			"wave64",
		).toBe(true);
		expect(
			isSelfContainedMedia(
				bytes(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00),
			),
			"asf or wma",
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
			["lowercase riff that is not wave64", text("riff is a word, not a file")],
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

describe("playlist check", () => {
	it("names the text formats that list other files", () => {
		const playlists: [string, Uint8Array][] = [
			["hls", text("#EXTM3U\n#EXT-X-VERSION:3\nsegment0.ts\n")],
			[
				"hls after a byte order mark",
				Uint8Array.from([0xef, 0xbb, 0xbf, ...text("#EXTM3U\n")]),
			],
			["hls after blank lines", text("\r\n\n  #extm3u\n")],
			["hls without its header", text("#EXT-X-TARGETDURATION:6\n")],
			["dash", text('<?xml version="1.0"?><MPD></MPD>')],
			[
				"dash without a prolog",
				text('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'),
			],
			["smil", text("<smil><body></body></smil>")],
			["asx", text('<ASX version="3.0">')],
			["concat script", text("ffconcat version 1.0\nfile a.mp4\n")],
			["pls", text("[playlist]\nFile1=http://example.com/a.mp3\n")],
			["sdp", text("v=0\r\no=- 0 0 IN IP4 203.0.113.1\r\n")],
			[
				"url list",
				text("https://example.com/a.ts\nhttps://example.com/b.ts\n"),
			],
		];
		for (const [name, sample] of playlists) {
			expect(looksLikePlaylist(sample), name).toBe(true);
			expect(sniffMedia(sample), name).toBe("playlist");
		}
	});

	it("does not call other files playlists", () => {
		const others: [string, Uint8Array][] = [
			["plain text", text("This is not a video. It is a note.")],
			["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
			["gif", text("GIF89a")],
			["json", text('{"url":"http://localhost"}')],
			["a word that starts like sdp", text("v=0.5 is the version")],
			["empty", new Uint8Array(0)],
			["only blank lines", text("\n\n\n")],
		];
		for (const [name, sample] of others) {
			expect(looksLikePlaylist(sample), name).toBe(false);
			expect(sniffMedia(sample), name).toBe("unknown");
		}
	});

	it("reads media as media even when it could pass for text", () => {
		expect(sniffMedia(text("#!AMR\n"))).toBe("media");
		expect(sniffMedia(withAscii([0, 0, 0, 0x20], "ftypisom"))).toBe("media");
	});
});
