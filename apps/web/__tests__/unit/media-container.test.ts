import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isSelfContainedMedia,
	looksLikePlaylist,
	MEDIA_CONTAINER_SNIFF_BYTES,
	sniffMedia,
	sniffMediaUrl,
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

const syncsafe = (size: number) => [
	(size >> 21) & 0x7f,
	(size >> 14) & 0x7f,
	(size >> 7) & 0x7f,
	size & 0x7f,
];
const FOOTER = 0x10;
const id3 = (bodyBytes = 0, { flags = 0, version = 4 } = {}) =>
	Uint8Array.from([
		...text("ID3"),
		version,
		0,
		flags,
		...syncsafe(bodyBytes),
		...new Array<number>(bodyBytes).fill(0),
		...(flags & FOOTER
			? [...text("3DI"), version, 0, flags, ...syncsafe(bodyBytes)]
			: []),
	]);
const join = (...parts: Uint8Array[]) =>
	Uint8Array.from(parts.flatMap((part) => [...part]));
const padded = (head: number[], length = 64) =>
	Uint8Array.from([...head, ...new Array<number>(length).fill(0)]);

const MPEG_FRAMES = padded([0xff, 0xfb, 0x90, 0x00]);
const ADTS_FRAMES = padded([0xff, 0xf1, 0x50, 0x80]);
const FFCONCAT = text("ffconcat version 1.0\nfile 'http://127.0.0.1/x'\n");
const HLS = text("#EXTM3U\n#EXT-X-VERSION:3\nhttp://10.0.0.1/a.ts\n");
const DASH = text(
	'<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>',
);
const DASH_WITHOUT_PROLOG = text('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">');
const PLAYLISTS: [string, Uint8Array][] = [
	["concat script", FFCONCAT],
	["hls playlist", HLS],
	["dash manifest", DASH],
	["dash manifest without a prolog", DASH_WITHOUT_PROLOG],
];
const ALBUM_ART_BYTES = 100_000;

describe("a file that starts with an ID3 tag", () => {
	const tags: [string, Uint8Array][] = [
		["an empty tag", id3()],
		["a tag with frames", id3(300)],
		["a tag with a footer", id3(40, { flags: FOOTER })],
		["a version 2.2 tag", id3(0, { version: 2 })],
		["a version 2.3 tag", id3(120, { version: 3 })],
		["two tags in a row", join(id3(20), id3(30))],
	];

	it.each(tags)("refuses a playlist behind %s", (_name, tag) => {
		for (const [name, playlist] of PLAYLISTS) {
			const sample = join(tag, playlist);
			expect(isSelfContainedMedia(sample), name).toBe(false);
			expect(looksLikePlaylist(sample), name).toBe(true);
			expect(sniffMedia(sample), name).toBe("playlist");
		}
	});

	it.each(tags)("accepts audio behind %s", (_name, tag) => {
		const audio: [string, Uint8Array][] = [
			["mpeg audio frames", MPEG_FRAMES],
			["adts frames", ADTS_FRAMES],
			["flac", text("fLaC\u0000\u0000\u0000\u0022")],
			["padding before the first frame", join(new Uint8Array(32), MPEG_FRAMES)],
		];
		for (const [name, frames] of audio) {
			const sample = join(tag, frames);
			expect(isSelfContainedMedia(sample), name).toBe(true);
			expect(looksLikePlaylist(sample), name).toBe(false);
			expect(sniffMedia(sample), name).toBe("media");
		}
	});

	it("accepts an mp3 with no tag", () => {
		expect(sniffMedia(MPEG_FRAMES)).toBe("media");
		expect(sniffMedia(ADTS_FRAMES)).toBe("media");
	});

	it("accepts a tag of album art that fills the bytes it was given", () => {
		const head = join(id3(ALBUM_ART_BYTES), MPEG_FRAMES).subarray(
			0,
			MEDIA_CONTAINER_SNIFF_BYTES,
		);

		expect(isSelfContainedMedia(head)).toBe(true);
		expect(sniffMedia(head)).toBe("media");
	});

	it("accepts a tag that ends exactly where the bytes do", () => {
		expect(sniffMedia(id3(300))).toBe("media");
		expect(sniffMedia(id3())).toBe("media");
	});

	it("reads a header it cannot parse as it did before", () => {
		const cutShort = text("ID3\u0004\u0000\u0000\u0000");
		const sizeNotSyncsafe = join(
			Uint8Array.from([...text("ID3"), 4, 0, 0, 0x80, 0, 0, 0]),
			FFCONCAT,
		);

		expect(sniffMedia(cutShort)).toBe("media");
		expect(sniffMedia(sizeNotSyncsafe)).toBe("media");
	});

	it("still refuses a playlist with no tag in front", () => {
		for (const [name, playlist] of PLAYLISTS) {
			expect(sniffMedia(playlist), name).toBe("playlist");
		}
	});
});

describe("sniffing a stored file by URL", () => {
	const URL = "https://storage.test/developer/app/video";

	function serve(file: Uint8Array, { ranges = true } = {}) {
		const fetched = vi.fn(async (_url: string, init?: RequestInit) => {
			const range = new Headers(init?.headers).get("range") ?? "";
			const [, from = "0", to = "0"] = /^bytes=(\d+)-(\d+)$/.exec(range) ?? [];
			const start = Number(from);
			if (!ranges && start > 0)
				return new Response(file.slice(), { status: 200 });
			if (start >= file.length) return new Response(null, { status: 416 });
			return new Response(file.slice(start, Number(to) + 1), { status: 206 });
		});
		vi.stubGlobal("fetch", fetched);
		return {
			ranges: () =>
				fetched.mock.calls.map(([, init]) =>
					new Headers(init?.headers).get("range"),
				),
		};
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads the first bytes once for a file with no tag", async () => {
		const stored = serve(withAscii([0, 0, 0, 0x20], "ftypisom", 8000));

		expect(await sniffMediaUrl(URL)).toBe("media");
		expect(stored.ranges()).toEqual(["bytes=0-4095"]);
	});

	it("reads the first bytes once when a short tag leaves the audio in view", async () => {
		const stored = serve(join(id3(60), padded([0xff, 0xfb, 0x90, 0x00], 8000)));

		expect(await sniffMediaUrl(URL)).toBe("media");
		expect(stored.ranges()).toEqual(["bytes=0-4095"]);
	});

	it("reads again at the end of a tag of album art and accepts the audio there", async () => {
		const stored = serve(join(id3(ALBUM_ART_BYTES), MPEG_FRAMES));

		expect(await sniffMediaUrl(URL)).toBe("media");
		expect(stored.ranges()).toEqual([
			"bytes=0-4095",
			`bytes=${ALBUM_ART_BYTES + 10}-${ALBUM_ART_BYTES + 10 + 4095}`,
		]);
	});

	it.each(PLAYLISTS)(
		"refuses a %s behind a tag longer than the first read",
		async (_name, playlist) => {
			const stored = serve(join(id3(ALBUM_ART_BYTES), playlist));

			expect(await sniffMediaUrl(URL)).toBe("playlist");
			expect(stored.ranges()).toHaveLength(2);
		},
	);

	it.each(PLAYLISTS)(
		"refuses a %s behind a short tag",
		async (_name, playlist) => {
			const stored = serve(join(id3(), playlist));

			expect(await sniffMediaUrl(URL)).toBe("playlist");
			expect(stored.ranges()).toEqual(["bytes=0-4095"]);
		},
	);

	it("accepts audio that sits behind padding after a tag of album art, as a short tag does", async () => {
		const padding = new Uint8Array(32);
		serve(join(id3(ALBUM_ART_BYTES), padding, MPEG_FRAMES));
		expect(await sniffMediaUrl(URL)).toBe("media");

		serve(join(id3(60), padding, MPEG_FRAMES));
		expect(await sniffMediaUrl(URL)).toBe("media");
	});

	it("still refuses a playlist behind padding after a tag of album art", async () => {
		serve(join(id3(ALBUM_ART_BYTES), text("\n\n  "), HLS));

		expect(await sniffMediaUrl(URL)).toBe("playlist");
	});

	it("refuses a playlist that starts in the last bytes of the first read", async () => {
		const tag = id3(MEDIA_CONTAINER_SNIFF_BYTES - 10 - 3);
		const stored = serve(join(tag, HLS, new Uint8Array(8000)));

		expect(await sniffMediaUrl(URL)).toBe("playlist");
		expect(stored.ranges()).toEqual([
			"bytes=0-4095",
			`bytes=${tag.length}-${tag.length + 4095}`,
		]);
	});

	it("follows several long tags to what comes after them", async () => {
		const tags = join(id3(9000), id3(9000), id3(9000));

		serve(join(tags, HLS));
		expect(await sniffMediaUrl(URL)).toBe("playlist");

		const stored = serve(join(tags, MPEG_FRAMES));
		expect(await sniffMediaUrl(URL)).toBe("media");
		expect(stored.ranges()).toHaveLength(4);
	});

	it("accepts a tag that says it is longer than the file, as before", async () => {
		const stored = serve(id3(ALBUM_ART_BYTES).subarray(0, 6000));

		expect(await sniffMediaUrl(URL)).toBe("media");
		expect(stored.ranges()).toHaveLength(2);
	});

	it("accepts the file as before when storage answers the second read with the whole file", async () => {
		serve(join(id3(ALBUM_ART_BYTES), HLS), { ranges: false });

		expect(await sniffMediaUrl(URL)).toBe("media");
	});

	it("fails when a read is refused", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 403 })),
		);

		await expect(sniffMediaUrl(URL)).rejects.toThrow(
			"Could not read the stored file (403)",
		);
	});
});
