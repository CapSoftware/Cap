import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	cachedDeliveryResolver,
	type DeliveryPart,
	type DeliveryResolver,
	type DeliveryVideo,
	deliveredSeconds,
	deliveryMp4Tier,
	hlsSecondsDelivered,
	meterDeliveryLog,
	parseDeliveryLine,
	parseHlsByteRanges,
	readDeliveryParts,
	readDeliveryVideo,
} from "@/lib/infra-delivery-log";
import {
	type DeliveryDayState,
	type DeliveryLogFile,
	type DeliveryLogSource,
	type DeliveryRow,
	type DeliveryStore,
	deliveryDayFinalAt,
	deliveryLogHour,
	readDeliveryLogLocation,
	rollupDeliveryDay,
	runDeliveryMetering,
} from "@/lib/infra-delivery-metering";

const APP = "appaaaaaaaaaaa1";
const OTHER_APP = "appbbbbbbbbbbb2";
const VIDEO = "vidaaaaaaaaaaa1";
const base = `/developer/${APP}/${VIDEO}/enc123456/out1`;

const PLAYLIST = [
	"#EXTM3U",
	"#EXT-X-VERSION:7",
	"#EXT-X-TARGETDURATION:4",
	"#EXT-X-PLAYLIST-TYPE:VOD",
	'#EXT-X-MAP:URI="720p.m4s",BYTERANGE="1000@0"',
	"#EXTINF:4.000000,",
	"#EXT-X-BYTERANGE:100000@1000",
	"720p.m4s",
	"#EXTINF:4.000000,",
	"#EXT-X-BYTERANGE:200000@101000",
	"720p.m4s",
	"#EXTINF:2.500000,",
	"#EXT-X-BYTERANGE:50000",
	"720p.m4s",
	"#EXT-X-ENDLIST",
].join("\n");

function line(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		date: "2026-11-12",
		time: "10:00:00",
		"c-ip": "192.0.2.1",
		"cs-method": "GET",
		"cs-uri-stem": `${base}/hls/720p.m4s`,
		"sc-status": "206",
		"sc-bytes": "100400",
		"sc-content-len": "100000",
		"sc-range-start": "1000",
		"sc-range-end": "100999",
		"x-edge-result-type": "Hit",
		"x-host-header": "example.test",
		...overrides,
	});
}

const SEGMENT_0 = { "sc-range-start": "1000", "sc-range-end": "100999" };

function gz(lines: string[]) {
	return Readable.from([gzipSync(`${lines.join("\n")}\n`)]);
}

const VIDEO_ROW: DeliveryVideo = {
	appId: APP,
	duration: 10.5,
	renditions: [
		{ name: "1080p", width: 1920, height: 1080, bytes: 1_050_000 },
		{ name: "720p", width: 1280, height: 720, bytes: 351_000 },
		{ name: "360p", width: 640, height: 360, bytes: 105_000 },
	],
	mp4Bytes: 10_500_000,
};

class FakeResolver implements DeliveryResolver {
	hlsCalls: string[] = [];
	videoCalls: string[] = [];
	async hls(key: string) {
		this.hlsCalls.push(key);
		return key.endsWith("/hls/720p.m3u8")
			? parseHlsByteRanges(PLAYLIST, "720p.m4s")
			: null;
	}
	async video({ videoId }: { videoId: string }) {
		this.videoCalls.push(videoId);
		return videoId === VIDEO ? VIDEO_ROW : null;
	}
}

describe("parseDeliveryLine", () => {
	it.each([["360p"], ["720p"], ["1080p"], ["1440p"], ["2160p"], ["audio"]])(
		"counts the %s rendition file",
		(tier) => {
			expect(
				parseDeliveryLine(line({ "cs-uri-stem": `${base}/hls/${tier}.m4s` })),
			).toEqual({
				day: "2026-11-12",
				appId: APP,
				videoId: VIDEO,
				kind: tier,
				key: `${base.slice(1)}/hls/${tier}.m4s`,
				rangeStart: 1000,
				bytes: 100400,
				bodyBytes: 100000,
			});
		},
	);

	it("counts an MP4 download", () => {
		expect(
			parseDeliveryLine(
				line({ "cs-uri-stem": `${base}/video.mp4`, "sc-status": "200" }),
			)?.kind,
		).toBe("mp4");
	});

	it.each([
		["/a1b2c3d4e5f6g7h/v1/result.mp4"],
		["/3gwrf77snqt5em1/abc/segments/video/segment_1.m4s"],
		[`${base}/poster.jpg`],
		[`${base}/hls/master.m3u8`],
		[`${base}/hls/720p.m3u8`],
		[`${base}/hls/480p.m4s`],
		[`${base}/captions/en.vtt`],
		[`/developer/${APP}/${VIDEO}/hls/720p.m4s`],
		[`/x/developer/${APP}/${VIDEO}/e/o/hls/720p.m4s`],
	])("ignores %s", (path) => {
		expect(parseDeliveryLine(line({ "cs-uri-stem": path }))).toBeNull();
	});

	it.each([
		["200", true],
		["206", true],
		["304", false],
		["403", false],
		["404", false],
		["416", false],
		["500", false],
	])("status %s delivered=%s", (status, delivered) => {
		expect(parseDeliveryLine(line({ "sc-status": status })) !== null).toBe(
			delivered,
		);
	});

	it.each([["HEAD"], ["OPTIONS"], ["POST"]])("ignores %s", (method) => {
		expect(parseDeliveryLine(line({ "cs-method": method }))).toBeNull();
	});

	it("ignores edge errors and empty responses", () => {
		expect(
			parseDeliveryLine(line({ "x-edge-result-type": "Error" })),
		).toBeNull();
		expect(parseDeliveryLine(line({ "sc-bytes": "0" }))).toBeNull();
	});

	it("caps body bytes at what left the edge, the content length and the range", () => {
		expect(parseDeliveryLine(line({ "sc-bytes": "600" }))).toMatchObject({
			bytes: 600,
			bodyBytes: 600,
		});
		expect(
			parseDeliveryLine(
				line({ "sc-content-len": "-", "sc-range-end": "1499" }),
			),
		).toMatchObject({ bytes: 100400, bodyBytes: 500 });
		expect(
			parseDeliveryLine(
				line({
					"sc-status": "200",
					"sc-content-len": "100000",
					"sc-range-start": "-",
					"sc-range-end": "-",
				}),
			),
		).toMatchObject({ rangeStart: 0, bodyBytes: 100000 });
	});

	it("rejects malformed lines", () => {
		expect(parseDeliveryLine("{not json /developer/")).toBeNull();
		expect(parseDeliveryLine(line({ "sc-bytes": "-" }))).toBeNull();
		expect(parseDeliveryLine(line({ date: "12/11/2026" }))).toBeNull();
		expect(parseDeliveryLine('["/developer/"]')).toBeNull();
	});

	it("never surfaces the client address", () => {
		expect(JSON.stringify(parseDeliveryLine(line()))).not.toContain(
			"192.0.2.1",
		);
	});
});

describe("HLS segment seconds", () => {
	const segments = parseHlsByteRanges(PLAYLIST, "720p.m4s") ?? [];

	it("reads byte ranges, including an implicit offset", () => {
		expect(segments).toEqual([
			{ start: 1000, end: 101000, duration: 4 },
			{ start: 101000, end: 301000, duration: 4 },
			{ start: 301000, end: 351000, duration: 2.5 },
		]);
	});

	it("refuses a playlist that is not one byte-range file", () => {
		expect(parseHlsByteRanges(PLAYLIST, "1080p.m4s")).toBeNull();
		expect(
			parseHlsByteRanges("#EXTM3U\n#EXTINF:4,\nseg0.m4s\n", "seg0.m4s"),
		).toBeNull();
		expect(parseHlsByteRanges("#EXTM3U\n", "720p.m4s")).toBeNull();
	});

	it.each([
		["the init section", 0, 1000, 0],
		["one whole segment", 1000, 100000, 4],
		["two whole segments", 1000, 300000, 8],
		["the whole file", 0, 351000, 10.5],
		["half of a segment, aborted", 101000, 100000, 2],
		["a range starting mid segment", 51000, 50000, 2],
		["init plus first segment", 0, 101000, 4],
		["past the end", 351000, 1000, 0],
	])("%s", (_name, start, length, seconds) => {
		expect(hlsSecondsDelivered(segments, start, length)).toBeCloseTo(
			seconds,
			9,
		);
	});
});

describe("deliveredSeconds", () => {
	const parsed = (overrides: Record<string, unknown> = {}) => {
		const request = parseDeliveryLine(line(overrides));
		if (!request) throw new Error("not parsed");
		return request;
	};

	it("maps a segment request to exact segment seconds", async () => {
		expect(
			await deliveredSeconds(parsed(SEGMENT_0), new FakeResolver()),
		).toEqual({
			tier: "720p",
			seconds: 4,
			method: "playlist",
		});
	});

	it("counts an aborted segment pro rata", async () => {
		expect(
			(
				await deliveredSeconds(
					parsed({ "sc-bytes": "25000" }),
					new FakeResolver(),
				)
			)?.seconds,
		).toBeCloseTo(1, 9);
	});

	it("estimates MP4 seconds from the file's average rate under its top rendition", async () => {
		expect(
			await deliveredSeconds(
				parsed({
					"cs-uri-stem": `${base}/video.mp4`,
					"sc-bytes": "3000400",
					"sc-content-len": "3000000",
					"sc-range-start": "0",
					"sc-range-end": "2999999",
				}),
				new FakeResolver(),
			),
		).toEqual({ tier: "1080p", seconds: 3, method: "mp4-estimate" });
	});

	it("drops an MP4 whose video is unknown or belongs to another app", async () => {
		const resolver = new FakeResolver();
		expect(
			await deliveredSeconds(
				parsed({
					"cs-uri-stem": `/developer/${APP}/vidzzzzzzzzzzz9/e/o/video.mp4`,
				}),
				resolver,
			),
		).toBeNull();
		expect(
			await deliveredSeconds(
				parsed({
					"cs-uri-stem": `/developer/${OTHER_APP}/${VIDEO}/e/o/video.mp4`,
				}),
				resolver,
			),
		).toBeNull();
	});

	it("gives audio no seconds and looks nothing up", async () => {
		const resolver = new FakeResolver();
		expect(
			await deliveredSeconds(
				parsed({ "cs-uri-stem": `${base}/hls/audio.m4s` }),
				resolver,
			),
		).toEqual({ tier: "audio", seconds: 0, method: "audio" });
		expect(resolver.hlsCalls).toEqual([]);
		expect(resolver.videoCalls).toEqual([]);
	});

	it("estimates from the video row's rendition rate when the playlist is gone", async () => {
		expect(
			await deliveredSeconds(
				parsed({ "cs-uri-stem": `${base}/hls/360p.m4s` }),
				new FakeResolver(),
			),
		).toEqual({ tier: "360p", seconds: 10, method: "rendition-estimate" });
	});

	it("keeps bytes but no seconds when the playlist and the video row are both gone", async () => {
		expect(
			await deliveredSeconds(
				parsed({
					"cs-uri-stem": `/developer/${APP}/vidzzzzzzzzzzz9/e/o/hls/360p.m4s`,
				}),
				new FakeResolver(),
			),
		).toEqual({ tier: "360p", seconds: 0, method: "no-rate" });
	});

	it("never estimates from another app's video row", async () => {
		expect(
			await deliveredSeconds(
				parsed({
					"cs-uri-stem": `/developer/${OTHER_APP}/${VIDEO}/e/o/hls/360p.m4s`,
				}),
				new FakeResolver(),
			),
		).toEqual({ tier: "360p", seconds: 0, method: "no-rate" });
	});
});

describe("cachedDeliveryResolver", () => {
	it("reads each playlist and video once per run and retries a failed read", async () => {
		const inner = new FakeResolver();
		let fail = true;
		const flaky: DeliveryResolver = {
			hls: async (key) => {
				if (fail) {
					fail = false;
					throw new Error("transient");
				}
				return inner.hls(key);
			},
			video: (request) => inner.video(request),
		};
		const cached = cachedDeliveryResolver(flaky);
		await expect(cached.hls("a/hls/720p.m3u8")).rejects.toThrow();
		await cached.hls("a/hls/720p.m3u8");
		await cached.hls("a/hls/720p.m3u8");
		await cached.video({ videoId: VIDEO, key: "a" });
		await cached.video({ videoId: VIDEO, key: "a" });
		expect(inner.hlsCalls).toHaveLength(1);
		expect(inner.videoCalls).toHaveLength(1);
	});
});

describe("readDeliveryVideo", () => {
	it("keeps known renditions and the MP4 size, and labels the MP4 with the top one", () => {
		const video = readDeliveryVideo({
			appId: APP,
			duration: 100,
			renditions: [
				{ name: "720p", width: 1280, height: 720, bytes: 5 },
				{ name: "1080p", width: 1920, height: 1080, bytes: 9 },
				{ name: "480p", width: 854, height: 480, bytes: 3 },
				"junk",
			],
			processing: { bytes: { mp4: 120_000_000 } },
		});
		expect(video).toEqual({
			appId: APP,
			duration: 100,
			renditions: [
				{ name: "720p", width: 1280, height: 720, bytes: 5 },
				{ name: "1080p", width: 1920, height: 1080, bytes: 9 },
			],
			mp4Bytes: 120_000_000,
		});
		expect(deliveryMp4Tier(video)).toBe("1080p");
		expect(
			deliveryMp4Tier(
				readDeliveryVideo({
					appId: APP,
					duration: 1,
					renditions: null,
					processing: null,
				}),
			),
		).toBeNull();
	});
});

describe("meterDeliveryLog", () => {
	it("aggregates a gzipped log per day, app, video and tier", async () => {
		const result = await meterDeliveryLog(
			gz([
				line(),
				line({
					"sc-range-start": "101000",
					"sc-range-end": "300999",
					"sc-content-len": "200000",
					"sc-bytes": "200400",
				}),
				line({ "cs-uri-stem": `${base}/hls/audio.m4s`, "sc-bytes": "50" }),
				line({ date: "2026-11-13" }),
				line({ "sc-status": "403" }),
				line({ "cs-uri-stem": "/3gwrf77snqt5em1/x/result.mp4" }),
				"",
			]),
			new FakeResolver(),
		);
		expect(result.lines).toBe(6);
		expect(result.delivered).toBe(4);
		expect(result.methods.seconds.playlist).toBe(12);
		expect(result.methods.requests).toMatchObject({ playlist: 3, audio: 1 });
		expect(result.parts).toEqual([
			["2026-11-12", APP, VIDEO, "720p", 2, 300800, 8000],
			["2026-11-12", APP, VIDEO, "audio", 1, 50, 0],
			["2026-11-13", APP, VIDEO, "720p", 1, 100400, 4000],
		]);
	});

	it("reads a last line with no trailing newline", async () => {
		const result = await meterDeliveryLog(
			Readable.from([gzipSync(`${line()}\n${line()}`)]),
			new FakeResolver(),
		);
		expect(result.parts[0]?.[4]).toBe(2);
	});

	it("fails on a truncated gzip instead of under-counting silently", async () => {
		const whole = gzipSync(`${line()}\n`.repeat(2000));
		await expect(
			meterDeliveryLog(
				Readable.from([whole.subarray(0, Math.floor(whole.length / 2))]),
				new FakeResolver(),
			),
		).rejects.toThrow();
	});

	it("keeps memory bounded on a large log", async () => {
		const LINES = 400_000;
		function* source() {
			for (let i = 0; i < LINES; i++) {
				const tier = ["360p", "720p", "1080p", "audio"][(i / 10) % 4];
				yield `${line({
					"cs-uri-stem":
						i % 10 === 0
							? `${base}/hls/${tier}.m4s`
							: `/regular${i % 97}/abc/segments/video/segment_${i}.m4s`,
					"cs(User-Agent)": "x".repeat(200),
				})}\n`;
			}
		}
		global.gc?.();
		const before = process.memoryUsage().heapUsed;
		let peak = before;
		const timer = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().heapUsed);
		}, 5);
		const result = await meterDeliveryLog(
			Readable.from(source()).pipe(createGzip()),
			new FakeResolver(),
		);
		clearInterval(timer);
		peak = Math.max(peak, process.memoryUsage().heapUsed);
		expect(result.lines).toBe(LINES);
		expect(result.delivered).toBe(LINES / 10);
		expect(result.parts).toHaveLength(4);
		expect(peak - before).toBeLessThan(64 * 1024 * 1024);
	}, 60_000);
});

describe("readDeliveryParts", () => {
	it("drops malformed stored parts", () => {
		const good: DeliveryPart = ["2026-11-12", APP, VIDEO, "720p", 1, 2, 3];
		expect(
			readDeliveryParts([
				good,
				["2026-11-12", APP, VIDEO, "mp4", 1, 2, 3],
				["2026-11-12", APP, VIDEO, "720p", -1, 2, 3],
				["bad", APP, VIDEO, "720p", 1, 2, 3],
				"x",
			]),
		).toEqual([good]);
		expect(readDeliveryParts(null)).toEqual([]);
	});
});

describe("rollupDeliveryDay", () => {
	it("sums one day's parts per app and tier", () => {
		expect(
			rollupDeliveryDay("2026-11-12", [
				["2026-11-12", APP, VIDEO, "720p", 10, 1000, 30_400],
				["2026-11-12", APP, "vidbbbbbbbbbbb2", "720p", 2, 200, 10_200],
				["2026-11-12", APP, VIDEO, "audio", 20, 900, 0],
				["2026-11-12", OTHER_APP, VIDEO, "1080p", 1, 5, 4_000],
				["2026-11-13", APP, VIDEO, "720p", 99, 99, 99_000],
			]),
		).toEqual([
			{ appId: APP, tier: "720p", seconds: 41, bytes: 1200, requests: 12 },
			{ appId: APP, tier: "audio", seconds: 0, bytes: 900, requests: 20 },
			{ appId: OTHER_APP, tier: "1080p", seconds: 4, bytes: 5, requests: 1 },
		]);
	});
});

class MemoryLogs implements DeliveryLogSource {
	files = new Map<string, { etag: string; lines: string[] }>();
	opened: string[] = [];
	put(name: string, lines: string[], etag = `"${name}"`) {
		this.files.set(name, { etag, lines });
	}
	async list(day: string): Promise<DeliveryLogFile[]> {
		return [...this.files.entries()].flatMap(([file, { etag }]) => {
			const hour = deliveryLogHour(file);
			return file.includes(`.${day}-`) && hour ? [{ file, etag, hour }] : [];
		});
	}
	async open(file: string) {
		this.opened.push(file);
		const entry = this.files.get(file);
		if (!entry) throw new Error("missing");
		return gz(entry.lines);
	}
}

type StoredRow = DeliveryRow & {
	day: string;
	final: boolean;
	finalizedAt: Date | null;
	updatedAt: Date;
};

class MemoryStore implements DeliveryStore {
	files = new Map<
		string,
		{ etag: string; hour: Date; parts: DeliveryPart[] }
	>();
	rows: StoredRow[] = [];
	day(day: string) {
		return this.rows.filter((row) => row.day === day);
	}
	async processedEtags(files: string[]) {
		const known = new Map<string, string>();
		for (const file of files) {
			const row = this.files.get(file);
			if (row) known.set(file, row.etag);
		}
		return known;
	}
	async saveFile(file: DeliveryLogFile, parts: DeliveryPart[]) {
		this.files.set(file.file, { etag: file.etag, hour: file.hour, parts });
	}
	async partsNear(from: Date, to: Date) {
		return [...this.files.values()]
			.filter((row) => row.hour >= from && row.hour < to)
			.flatMap((row) => row.parts);
	}
	async dayStates(from: string, to: string) {
		const states = new Map<string, DeliveryDayState>();
		for (const row of this.rows) {
			if (row.day < from || row.day > to) continue;
			const state = states.get(row.day);
			states.set(row.day, {
				final: (state?.final ?? false) || row.final,
				updatedAt:
					state && state.updatedAt > row.updatedAt
						? state.updatedAt
						: row.updatedAt,
			});
		}
		return states;
	}
	async replaceDay(
		day: string,
		rows: DeliveryRow[],
		now: Date,
		final: boolean,
	) {
		if (this.day(day).some((row) => row.final)) return "final" as const;
		this.rows = [
			...this.rows.filter((row) => row.day !== day),
			...rows.map((row) => ({
				...row,
				day,
				final,
				finalizedAt: final ? now : null,
				updatedAt: now,
			})),
		];
		return "written" as const;
	}
	async finalizeDay(day: string, now: Date) {
		for (const row of this.day(day)) {
			if (!row.final) {
				row.final = true;
				row.finalizedAt = now;
			}
		}
	}
	async pruneFiles(before: Date) {
		for (const [file, row] of this.files) {
			if (row.hour < before) this.files.delete(file);
		}
	}
}

const at = (iso: string) => new Date(iso);
const run = (logs: MemoryLogs, store: MemoryStore, now: Date, maxFiles = 100) =>
	runDeliveryMetering({
		source: logs,
		store,
		resolver: new FakeResolver(),
		now,
		maxFiles,
		outOfTime: () => false,
	});

const play = (date: string) => line({ date });

describe("runDeliveryMetering", () => {
	it("recomputes yesterday and today on every run, refreshing updatedAt even when unchanged", async () => {
		const logs = new MemoryLogs();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		logs.put("D.2026-11-13-08.b.gz", [play("2026-11-13")]);
		const store = new MemoryStore();

		const first = await run(logs, store, at("2026-11-13T09:23:00Z"));
		expect(first).toMatchObject({
			listed: 2,
			processed: 2,
			recomputed: ["2026-11-12", "2026-11-13"],
		});
		expect(first.methods.requests.playlist).toBe(2);
		expect(first.methods.seconds.playlist).toBe(8);
		const counts = store.rows.map(({ updatedAt: _, ...row }) => row);

		const second = await run(logs, store, at("2026-11-13T10:23:00Z"));
		expect(second).toMatchObject({
			processed: 0,
			recomputed: ["2026-11-12", "2026-11-13"],
		});
		expect(store.rows.map(({ updatedAt: _, ...row }) => row)).toEqual(counts);
		expect(
			store.rows.every(
				(row) => row.updatedAt.toISOString() === "2026-11-13T10:23:00.000Z",
			),
		).toBe(true);
		expect(logs.opened).toHaveLength(2);
		expect(store.day("2026-11-12")).toMatchObject([
			{
				appId: APP,
				tier: "720p",
				seconds: 4,
				bytes: 100400,
				requests: 1,
				final: false,
				finalizedAt: null,
			},
		]);
	});

	it("replaces a day when a late file arrives instead of adding to it", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-22.a.gz", [play("2026-11-12")]);
		await run(logs, store, at("2026-11-12T23:23:00Z"));
		await run(logs, store, at("2026-11-13T00:23:00Z"));
		logs.put("D.2026-11-12-23.late.gz", [play("2026-11-12")]);
		logs.put("D.2026-11-13-00.c.gz", [play("2026-11-12"), play("2026-11-13")]);
		const result = await run(logs, store, at("2026-11-13T01:23:00Z"));
		expect(result.processed).toBe(2);
		expect(store.day("2026-11-12")).toMatchObject([
			{ tier: "720p", seconds: 12, bytes: 301200, requests: 3 },
		]);
		expect(store.day("2026-11-13")[0]?.requests).toBe(1);
	});

	it("re-reads a file whose ETag changed and drops its old counts", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")], '"1"');
		await run(logs, store, at("2026-11-13T09:00:00Z"));
		logs.put(
			"D.2026-11-12-10.a.gz",
			[play("2026-11-12"), play("2026-11-12")],
			'"2"',
		);
		await run(logs, store, at("2026-11-13T10:00:00Z"));
		expect(store.day("2026-11-12")[0]).toMatchObject({
			seconds: 8,
			requests: 2,
		});
	});

	it("handles a bounded number of files per run and picks up the rest next run", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		for (let hour = 0; hour < 10; hour++) {
			logs.put(`D.2026-11-12-${String(hour).padStart(2, "0")}.x.gz`, [
				play("2026-11-12"),
			]);
		}
		const now = at("2026-11-13T09:00:00Z");
		expect(await run(logs, store, now, 4)).toMatchObject({
			processed: 4,
			remaining: 6,
		});
		expect(store.day("2026-11-12")[0]?.requests).toBe(4);
		await run(logs, store, now, 4);
		expect(await run(logs, store, now, 4)).toMatchObject({
			processed: 2,
			remaining: 0,
		});
		expect(store.day("2026-11-12")[0]).toMatchObject({
			requests: 10,
			seconds: 40,
		});
	});

	it("keeps going when one file fails and retries it next run", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		logs.put("D.2026-11-12-11.b.gz", [play("2026-11-12")]);
		const open = logs.open.bind(logs);
		logs.open = async (file) => {
			if (file.includes("-11.")) throw new Error("boom");
			return open(file);
		};
		const now = at("2026-11-13T09:00:00Z");
		expect(await run(logs, store, now)).toMatchObject({
			processed: 1,
			failed: 1,
		});
		logs.open = open;
		expect(await run(logs, store, now)).toMatchObject({
			processed: 1,
			failed: 0,
		});
		expect(store.day("2026-11-12")[0]?.requests).toBe(2);
	});

	it("clears stale rows of a day it recomputes", async () => {
		const store = new MemoryStore();
		await store.replaceDay(
			"2026-11-13",
			[{ appId: OTHER_APP, tier: "360p", seconds: 1, bytes: 1, requests: 1 }],
			at("2026-11-13T01:00:00Z"),
			false,
		);
		await run(new MemoryLogs(), store, at("2026-11-13T09:00:00Z"));
		expect(store.day("2026-11-13")).toEqual([]);
	});

	it("leaves a day alone after D+1 and finalizes it at 02:00 UTC on D+2, not 01:59", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		await run(logs, store, at("2026-11-13T23:23:00Z"));
		const settled = structuredClone(store.day("2026-11-12"));

		logs.put("D.2026-11-12-23.late.gz", [play("2026-11-12")]);
		const early = await run(logs, store, at("2026-11-14T01:59:59Z"));
		expect(early.finalized).toEqual([]);
		expect(store.day("2026-11-12")).toEqual(settled);

		expect(deliveryDayFinalAt("2026-11-12").toISOString()).toBe(
			"2026-11-14T02:00:00.000Z",
		);
		const due = await run(logs, store, at("2026-11-14T02:00:00Z"));
		expect(due.finalized).toEqual(["2026-11-12"]);
		expect(store.day("2026-11-12")).toEqual(
			settled.map((row) => ({
				...row,
				final: true,
				finalizedAt: at("2026-11-14T02:00:00Z"),
			})),
		);
	});

	it("never rewrites or deletes a final day", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		await run(logs, store, at("2026-11-13T23:23:00Z"));
		await run(logs, store, at("2026-11-14T02:23:00Z"));
		const closed = structuredClone(store.day("2026-11-12"));
		expect(closed[0]?.final).toBe(true);

		logs.put("D.2026-11-12-11.later.gz", [play("2026-11-12")]);
		const later = await run(logs, store, at("2026-11-15T05:23:00Z"));
		expect(later.finalized).not.toContain("2026-11-12");
		expect(store.day("2026-11-12")).toEqual(closed);
		expect(
			await store.replaceDay(
				"2026-11-12",
				[],
				at("2026-11-15T06:00:00Z"),
				false,
			),
		).toBe("final");
		expect(store.day("2026-11-12")).toEqual(closed);
	});

	it("recomputes and finalizes a day in one step when the cron was down during D+1", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		await run(logs, store, at("2026-11-12T20:23:00Z"));
		expect(store.day("2026-11-12")[0]?.requests).toBe(1);

		logs.put("D.2026-11-12-21.b.gz", [play("2026-11-12")]);
		logs.put("D.2026-11-13-00.c.gz", [play("2026-11-12"), play("2026-11-13")]);
		const back = await run(logs, store, at("2026-11-14T03:23:00Z"));
		expect(back.finalized).toEqual(["2026-11-12"]);
		expect(store.day("2026-11-12")).toMatchObject([
			{
				requests: 3,
				seconds: 12,
				final: true,
				finalizedAt: at("2026-11-14T03:23:00Z"),
				updatedAt: at("2026-11-14T03:23:00Z"),
			},
		]);
		expect(store.day("2026-11-13")[0]).toMatchObject({
			requests: 1,
			final: false,
		});
	});

	it("defers a catch-up finalize while that day's log files are still unread", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		for (let hour = 0; hour < 6; hour++) {
			logs.put(`D.2026-11-12-${String(hour).padStart(2, "0")}.x.gz`, [
				play("2026-11-12"),
			]);
		}
		const first = await run(logs, store, at("2026-11-14T03:00:00Z"), 4);
		expect(first).toMatchObject({ deferred: ["2026-11-12"], finalized: [] });
		expect(store.day("2026-11-12")).toEqual([]);
		const second = await run(logs, store, at("2026-11-14T04:00:00Z"), 4);
		expect(second.finalized).toEqual(["2026-11-12"]);
		expect(store.day("2026-11-12")[0]).toMatchObject({
			requests: 6,
			final: true,
		});
	});

	it("never meters a day before metering started", async () => {
		const logs = new MemoryLogs();
		logs.put("D.2026-11-11-10.a.gz", [play("2026-11-11")]);
		const store = new MemoryStore();
		const result = await run(logs, store, at("2026-11-14T03:00:00Z"));
		expect(result.finalized).toEqual(["2026-11-12"]);
		expect(store.day("2026-11-11")).toEqual([]);
		expect(logs.opened).toEqual([]);
	});

	it("prunes stored file counts after the log retention window", async () => {
		const logs = new MemoryLogs();
		const store = new MemoryStore();
		logs.put("D.2026-11-12-10.a.gz", [play("2026-11-12")]);
		await run(logs, store, at("2026-11-13T09:00:00Z"));
		await run(new MemoryLogs(), store, at("2026-11-30T00:00:00Z"));
		expect(store.files.size).toBe(0);
	});
});

describe("delivery log location", () => {
	it("reads the bucket and key prefix", () => {
		expect(
			readDeliveryLogLocation("s3://logs-bucket/AWSLogs/1/CloudFront/DIST."),
		).toEqual({ bucket: "logs-bucket", prefix: "AWSLogs/1/CloudFront/DIST." });
		expect(readDeliveryLogLocation(undefined)).toBeNull();
		expect(readDeliveryLogLocation("logs-bucket/x")).toBeNull();
	});

	it("reads the hour from a log file name", () => {
		expect(deliveryLogHour("DIST.2026-11-12-07.abc123.gz")?.toISOString()).toBe(
			"2026-11-12T07:00:00.000Z",
		);
		expect(deliveryLogHour("DIST.2026-11-12.abc.gz")).toBeNull();
	});
});
