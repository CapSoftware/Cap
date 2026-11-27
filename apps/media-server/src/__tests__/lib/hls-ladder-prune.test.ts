import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHlsLadderMaster } from "../../lib/hls-ladder";
import type { EncodedHlsLadder } from "../../lib/hls-ladder-encode";
import {
	averageBitrate,
	invertedRungs,
	pruneInvertedHlsRungs,
	removeHlsMasterVariants,
} from "../../lib/hls-ladder-prune";

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=779000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=950000,AVERAGE-BANDWIDTH=809000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
720p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=243000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p.m3u8
`;

const SECONDS = 120;
const RUNGS = [
	{ name: "1080p", width: 1920, height: 1080, kbps: 651 },
	{ name: "720p", width: 1280, height: 720, kbps: 681 },
	{ name: "360p", width: 640, height: 360, kbps: 215 },
];

function rung(name: string, pixels: number, kbps: number) {
	return { name, pixels, averageBitrate: kbps * 1000 };
}

describe("invertedRungs", () => {
	test("drops a 720p that costs more than the 1080p above it", () => {
		expect(
			invertedRungs([
				rung("1080p", 1920 * 1080, 651),
				rung("720p", 1280 * 720, 681),
				rung("360p", 640 * 360, 215),
			]),
		).toEqual(["720p"]);
	});

	test("compares each rung with the next kept rung above it", () => {
		expect(
			invertedRungs([
				rung("1080p", 1920 * 1080, 900),
				rung("720p", 1280 * 720, 500),
				rung("360p", 640 * 360, 500),
			]),
		).toEqual(["360p"]);
		expect(
			invertedRungs([
				rung("1080p", 1920 * 1080, 600),
				rung("720p", 1280 * 720, 700),
				rung("360p", 640 * 360, 650),
			]),
		).toEqual(["720p", "360p"]);
	});

	test("never drops the top rung and walks from the largest picture", () => {
		expect(
			invertedRungs([
				rung("360p", 640 * 360, 2000),
				rung("1080p", 1920 * 1080, 100),
			]),
		).toEqual(["360p"]);
		expect(invertedRungs([rung("1080p", 1920 * 1080, 100)])).toEqual([]);
		expect(invertedRungs([])).toEqual([]);
	});

	test("keeps a ladder whose bitrates fall with size", () => {
		expect(
			invertedRungs([
				rung("1080p", 1920 * 1080, 3000),
				rung("720p", 1280 * 720, 1500),
				rung("360p", 640 * 360, 400),
			]),
		).toEqual([]);
	});
});

describe("averageBitrate", () => {
	test("is media bytes in bits over the duration", () => {
		expect(averageBitrate(651_000 * 15, 120)).toBe(651_000);
		expect(() => averageBitrate(1, 0)).toThrow();
	});
});

describe("removeHlsMasterVariants", () => {
	test("lists only kept renditions and keeps the audio group", () => {
		const rewritten = removeHlsMasterVariants(MASTER, new Set(["720p.m3u8"]));
		expect(rewritten).toContain('URI="audio.m3u8"');
		expect(rewritten).not.toContain("720p");
		expect(rewritten).not.toContain("RESOLUTION=1280x720");
		const parsed = parseHlsLadderMaster(rewritten);
		expect(parsed.video.map((variant) => variant.name)).toEqual([
			"1080p",
			"360p",
		]);
		expect(parsed.audio?.playlist).toBe("audio.m3u8");
	});

	test("leaves the master unchanged when nothing is removed", () => {
		expect(removeHlsMasterVariants(MASTER, new Set())).toBe(MASTER);
	});
});

describe("pruneInvertedHlsRungs", () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-ladder-prune-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function file(name: string, contents: string, bytes = contents.length) {
		const path = join(dir, name);
		writeFileSync(path, contents);
		return {
			name,
			path,
			bytes,
			contentType: name.endsWith(".m4s")
				? "video/mp4"
				: "application/vnd.apple.mpegurl",
		};
	}

	test("rewrites the master and drops the pruned rendition's files", async () => {
		const playlist = [
			"#EXTM3U",
			...Array.from({ length: SECONDS / 4 }, () => "#EXTINF:4.000000,"),
			"#EXT-X-ENDLIST",
		].join("\n");
		const renditions = RUNGS.map((variant) => ({
			name: variant.name,
			playlist: `${variant.name}.m3u8`,
			media: `${variant.name}.m4s`,
			width: variant.width,
			height: variant.height,
			bandwidth: null,
			averageBandwidth: null,
			codecs: null,
			bytes: (variant.kbps * 1000 * SECONDS) / 8,
		}));
		const audio = {
			name: "audio",
			playlist: "audio.m3u8",
			media: "audio.m4s",
			width: null,
			height: null,
			bandwidth: null,
			averageBandwidth: null,
			codecs: null,
			bytes: 4,
		};
		const ladder: EncodedHlsLadder = {
			files: [
				file("master.m3u8", MASTER),
				...renditions.flatMap((rendition) => [
					file(rendition.playlist, playlist),
					file(rendition.media, "m4s", rendition.bytes),
				]),
				file("audio.m3u8", playlist),
				file("audio.m4s", "m4s"),
			],
			result: { encoder: "libx264", renditions, audio },
			poster: { path: join(dir, "1080p.m4s"), durationSeconds: SECONDS },
			frameRate: "30",
			cleanup: async () => {},
		};

		const { ladder: kept, pruned } = await pruneInvertedHlsRungs(ladder);

		expect(pruned).toEqual(["720p"]);
		expect(kept.result.renditions.map((rendition) => rendition.name)).toEqual([
			"1080p",
			"360p",
		]);
		expect(kept.result.audio).toBe(audio);
		expect(kept.files.map((entry) => entry.name)).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"360p.m3u8",
			"360p.m4s",
			"audio.m3u8",
			"audio.m4s",
		]);
		const master = readFileSync(join(dir, "master.m3u8"), "utf8");
		expect(kept.files[0]?.bytes).toBe(Buffer.byteLength(master));
		expect(
			parseHlsLadderMaster(master).video.map((variant) => variant.name),
		).toEqual(["1080p", "360p"]);
		expect(kept.poster).toBe(ladder.poster);
	});
});
