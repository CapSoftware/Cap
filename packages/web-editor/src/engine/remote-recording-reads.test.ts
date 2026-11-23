import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createRecordingIndexer,
	type RecordingIndexer,
} from "@cap/recorder-core/recording-index";
import {
	ALL_FORMATS,
	type EncodedPacket,
	EncodedPacketSink,
	Input,
	UrlSource,
} from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	acquireMediaInputAt,
	mediaSource,
	releaseMediaSources,
	warmMediaSource,
} from "./browser-media-inputs";
import { probeBrowserMedia } from "./browser-media-probe";
import {
	firstHeadBytes,
	firstTailBytes,
	RemoteMedia,
} from "./browser-remote-media";
import { recording as webmRecording } from "./webm-fixtures";

/// A recording as the web recorder uploads it: ftyp, a moov with mvex (audio
/// track first, then video), then one moof + mdat every two seconds with no
/// fragment index. Built from one real two-second fragment, repeated with its
/// sequence number and decode times moved on, and padded to the size a 1080p
/// screen fragment has, so a two-hour file costs nothing to serve.
const seed = new Uint8Array(
	readFileSync(new URL("./fixtures/recorder-fragment.mp4", import.meta.url)),
);
const seedView = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);

type Box = { type: string; start: number; end: number };
function topBoxes(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: Box[] = [];
	for (let at = 0; at + 8 <= bytes.byteLength; ) {
		const size = view.getUint32(at);
		out.push({
			type: new TextDecoder().decode(bytes.subarray(at + 4, at + 8)),
			start: at,
			end: at + size,
		});
		at += size;
	}
	return out;
}

const seedBoxes = topBoxes(seed);
const moovBox = seedBoxes.find((box) => box.type === "moov");
const moofBox = seedBoxes.find((box) => box.type === "moof");
const mdatBox = seedBoxes.find((box) => box.type === "mdat");
if (!moovBox || !moofBox || !mdatBox) throw new Error("seed is not fragmented");
const initBytes = seed.subarray(0, moovBox.end);
const SECONDS_PER_FRAGMENT = 2;
const FRAGMENT_BYTES = 384 * 1024;
const MOOF_BYTES = moofBox.end - moofBox.start;
const MDAT_PAYLOAD = mdatBox.end - mdatBox.start - 8;

/// Offsets inside the seed's moof of the mfhd sequence number and each
/// traf's tfdt (with its track timescale step per fragment).
const patches: { at: number; step: number; wide: boolean }[] = [];
let sequenceAt = -1;
{
	const timescales = new Map<number, number>();
	for (let at = moovBox.start + 8; at < moovBox.end; ) {
		const size = seedView.getUint32(at);
		if (new TextDecoder().decode(seed.subarray(at + 4, at + 8)) === "trak") {
			const trak = seed.subarray(at, at + size);
			const text = new TextDecoder("latin1").decode(trak);
			const tkhd = text.indexOf("tkhd");
			const mdhd = text.indexOf("mdhd");
			const tv = new DataView(trak.buffer, trak.byteOffset);
			const trackId = tv.getUint32(tkhd + 4 + (trak[tkhd + 4] === 1 ? 20 : 12));
			const timescale = tv.getUint32(
				mdhd + 4 + (trak[mdhd + 4] === 1 ? 20 : 12),
			);
			timescales.set(trackId, timescale);
		}
		at += size;
	}
	const text = new TextDecoder("latin1").decode(
		seed.subarray(moofBox.start, moofBox.end),
	);
	sequenceAt = moofBox.start + text.indexOf("mfhd") + 8;
	let trackId = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.startsWith("tfhd", index)) {
			trackId = seedView.getUint32(moofBox.start + index + 8);
		}
		if (text.startsWith("tfdt", index)) {
			const at = moofBox.start + index + 4;
			const timescale = timescales.get(trackId) ?? 1;
			patches.push({
				at: at + 4,
				step: timescale * SECONDS_PER_FRAGMENT,
				wide: seed[at] === 1,
			});
		}
	}
}

function fragmentBytes(index: number) {
	const out = new Uint8Array(FRAGMENT_BYTES);
	out.set(seed.subarray(moofBox?.start, moofBox?.end));
	const view = new DataView(out.buffer);
	const base = moofBox?.start ?? 0;
	view.setUint32(sequenceAt - base, index + 1);
	for (const patch of patches) {
		const value = patch.step * index;
		if (patch.wide) view.setBigUint64(patch.at - base, BigInt(value));
		else view.setUint32(patch.at - base, value);
	}
	view.setUint32(MOOF_BYTES, FRAGMENT_BYTES - MOOF_BYTES);
	out.set(new TextEncoder().encode("mdat"), MOOF_BYTES + 4);
	out.set(
		seed.subarray(
			(mdatBox?.start ?? 0) + 8,
			(mdatBox?.start ?? 0) + 8 + MDAT_PAYLOAD,
		),
		MOOF_BYTES + 8,
	);
	return out;
}

/// An mfra with only its mfro, as a muxer that finalizes the file writes.
const MFRA = new Uint8Array([
	0, 0, 0, 24, 0x6d, 0x66, 0x72, 0x61, 0, 0, 0, 16, 0x6d, 0x66, 0x72, 0x6f, 0,
	0, 0, 0, 0, 0, 0, 24,
]);

/// A WebM screen recording as MediaRecorder writes one in Firefox: clusters
/// of unknown size, no Cues, no Duration. Built from one real two-second VP8
/// cluster whose timecode is rewritten for each copy.
const webmSeed = new Uint8Array(
	readFileSync(new URL("./fixtures/recorder-cluster.webm", import.meta.url)),
);
const webmClusterAt = webmSeed.findIndex(
	(_, index) =>
		webmSeed[index] === 0x1f &&
		webmSeed[index + 1] === 0x43 &&
		webmSeed[index + 2] === 0xb6 &&
		webmSeed[index + 3] === 0x75,
);
const webmInit = webmSeed.subarray(0, webmClusterAt);
const webmTimecodeAt = webmClusterAt + 12;
if (webmSeed[webmTimecodeAt] !== 0xe7) throw new Error("seed cluster layout");
const webmBlocks = webmSeed.subarray(
	webmTimecodeAt + 2 + ((webmSeed[webmTimecodeAt + 1] ?? 0) & 0x7f),
);
const WEBM_CLUSTER_BYTES = 18 + webmBlocks.byteLength;

function webmCluster(index: number) {
	const out = new Uint8Array(WEBM_CLUSTER_BYTES);
	out.set([0x1f, 0x43, 0xb6, 0x75, 1, 255, 255, 255, 255, 255, 255, 255]);
	out.set([0xe7, 0x84], 12);
	new DataView(out.buffer).setUint32(14, index * SECONDS_PER_FRAGMENT * 1000);
	out.set(webmBlocks, 18);
	return out;
}

function webmRange(
	clusters: number,
	start: number,
	end: number,
	trailer?: Uint8Array,
) {
	const out = new Uint8Array(end - start);
	const clustersEnd = webmInit.byteLength + clusters * WEBM_CLUSTER_BYTES;
	if (trailer && end > clustersEnd) {
		const from = Math.max(start, clustersEnd);
		out.set(
			trailer.subarray(from - clustersEnd, end - clustersEnd),
			from - start,
		);
	}
	for (let at = start; at < end; ) {
		if (at < webmInit.byteLength) {
			const stop = Math.min(end, webmInit.byteLength);
			out.set(webmInit.subarray(at, stop), at - start);
			at = stop;
			continue;
		}
		const index = Math.floor((at - webmInit.byteLength) / WEBM_CLUSTER_BYTES);
		const clusterStart = webmInit.byteLength + index * WEBM_CLUSTER_BYTES;
		const stop = Math.min(end, clusterStart + WEBM_CLUSTER_BYTES);
		if (index >= clusters) break;
		out.set(
			webmCluster(index).subarray(at - clusterStart, stop - clusterStart),
			at - start,
		);
		at = stop;
	}
	return out;
}

/// A screen recording as Firefox's MediaRecorder writes one: a cluster of
/// unknown size every 7.5 seconds holding one key frame of 400 KB and the
/// 224 frames after it at 10 KB each, about 2.6 MB a cluster. Built from the
/// seed's own VP8 frames, the key frame and the deltas after it padded to
/// those sizes, so a long file costs nothing to serve.
const LONG_CLUSTER_SECONDS = 7.5;
const LONG_CLUSTER_FRAMES = 225;
const LONG_KEY_BYTES = 400 * 1024;
const LONG_DELTA_BYTES = 10 * 1024;
const seedFrames: Uint8Array[] = [];
for (let at = 0; at < webmBlocks.byteLength; ) {
	if (webmBlocks[at] !== 0xa3) throw new Error("seed block layout");
	const first = webmBlocks[at + 1] ?? 0;
	const length = Math.clz32(first) - 23;
	let size = first & (0xff >> length);
	for (let index = 1; index < length; index++) {
		size = size * 256 + (webmBlocks[at + 1 + index] ?? 0);
	}
	const body = at + 1 + length;
	seedFrames.push(webmBlocks.subarray(body + 4, body + size));
	at = body + size;
}
const longCluster = (() => {
	const blocks = Array.from({ length: LONG_CLUSTER_FRAMES }, (_, index) => {
		const frame = seedFrames[index === 0 ? 0 : 1 + ((index - 1) % 59)];
		if (!frame) throw new Error("seed frames");
		const payload = index === 0 ? LONG_KEY_BYTES : LONG_DELTA_BYTES;
		const block = new Uint8Array(5 + 4 + payload);
		const view = new DataView(block.buffer);
		block[0] = 0xa3;
		view.setUint32(1, 0x10000000 | (4 + payload));
		block[5] = 0x81;
		view.setInt16(6, Math.round((index * 1000) / 30));
		block[8] = index === 0 ? 0x80 : 0;
		block.set(frame, 9);
		return block;
	});
	const out = new Uint8Array(
		18 + blocks.reduce((sum, block) => sum + block.byteLength, 0),
	);
	out.set([0x1f, 0x43, 0xb6, 0x75, 1, 255, 255, 255, 255, 255, 255, 255]);
	out.set([0xe7, 0x84], 12);
	let at = 18;
	for (const block of blocks) {
		out.set(block, at);
		at += block.byteLength;
	}
	return out;
})();

function longRange(clusters: number, start: number, end: number) {
	const out = new Uint8Array(end - start);
	for (let at = start; at < end; ) {
		if (at < webmInit.byteLength) {
			const stop = Math.min(end, webmInit.byteLength);
			out.set(webmInit.subarray(at, stop), at - start);
			at = stop;
			continue;
		}
		const index = Math.floor(
			(at - webmInit.byteLength) / longCluster.byteLength,
		);
		if (index >= clusters) break;
		const clusterStart = webmInit.byteLength + index * longCluster.byteLength;
		const stop = Math.min(end, clusterStart + longCluster.byteLength);
		const timecode = new Uint8Array(4);
		new DataView(timecode.buffer).setUint32(
			0,
			index * LONG_CLUSTER_SECONDS * 1000,
		);
		for (let byte = at; byte < stop; byte++) {
			const inCluster = byte - clusterStart;
			out[byte - start] =
				inCluster >= 14 && inCluster < 18
					? (timecode[inCluster - 14] ?? 0)
					: (longCluster[inCluster] ?? 0);
		}
		at = stop;
	}
	return out;
}

type Recording = { fragments: number; trailer?: Uint8Array; cutBytes?: number };

function recordingSize(recording: Recording) {
	return (
		initBytes.byteLength +
		recording.fragments * FRAGMENT_BYTES +
		(recording.trailer?.byteLength ?? 0) -
		(recording.cutBytes ?? 0)
	);
}

function recordingRange(recording: Recording, start: number, end: number) {
	const out = new Uint8Array(end - start);
	const fragmentsEnd =
		initBytes.byteLength + recording.fragments * FRAGMENT_BYTES;
	let at = start;
	while (at < end) {
		if (at < initBytes.byteLength) {
			const stop = Math.min(end, initBytes.byteLength);
			out.set(initBytes.subarray(at, stop), at - start);
			at = stop;
		} else if (at < fragmentsEnd) {
			const index = Math.floor((at - initBytes.byteLength) / FRAGMENT_BYTES);
			const fragmentStart = initBytes.byteLength + index * FRAGMENT_BYTES;
			const stop = Math.min(end, fragmentStart + FRAGMENT_BYTES);
			out.set(
				fragmentBytes(index).subarray(at - fragmentStart, stop - fragmentStart),
				at - start,
			);
			at = stop;
		} else {
			const trailer = recording.trailer ?? new Uint8Array();
			out.set(
				trailer.subarray(at - fragmentsEnd, end - fragmentsEnd),
				at - start,
			);
			at = end;
		}
	}
	return out;
}

const recordings = new Map<string, Recording>();
const files = new Map<string, Uint8Array>();
const webmRecordings = new Map<
	string,
	{ clusters: number; trailer?: Uint8Array }
>();
const served = new Map<string, number>();
const generated = new Map<
	string,
	{ size: number; range: (start: number, end: number) => Uint8Array }
>();

/// Paths that answer 503, as storage does while it is unreachable.
const unavailable = new Set<string>();

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (unavailable.has(url.pathname)) {
		response.writeHead(503).end();
		return;
	}
	const recording = recordings.get(url.pathname);
	const bytes = files.get(url.pathname);
	const webm = webmRecordings.get(url.pathname);
	const made = generated.get(url.pathname);
	if (!recording && !bytes && webm === undefined && !made) {
		response.writeHead(404).end();
		return;
	}
	const size = made
		? made.size
		: recording
			? recordingSize(recording)
			: webm !== undefined
				? webmInit.byteLength +
					webm.clusters * WEBM_CLUSTER_BYTES +
					(webm.trailer?.byteLength ?? 0)
				: (bytes?.byteLength ?? 0);
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
	if (!range) {
		response.writeHead(400).end();
		return;
	}
	const start = Number(range[1]);
	const end = Math.min(size, range[2] ? Number(range[2]) + 1 : size);
	if (start >= end) {
		response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
		return;
	}
	served.set(url.pathname, (served.get(url.pathname) ?? 0) + end - start);
	response.writeHead(206, {
		"Content-Type": "video/mp4",
		"Content-Length": end - start,
		"Content-Range": `bytes ${start}-${end - 1}/${size}`,
	});
	response.end(
		made
			? made.range(start, end)
			: recording
				? recordingRange(recording, start, end)
				: webm !== undefined
					? webmRange(webm.clusters, start, end, webm.trailer)
					: bytes?.subarray(start, end),
	);
});

let origin = "";
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
	releaseMediaSources();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function serve(name: string, recording: Recording) {
	recordings.set(`/${name}`, recording);
	served.set(`/${name}`, 0);
	return {
		url: `${origin}/${name}`,
		size: recordingSize(recording),
		duration: recording.fragments * SECONDS_PER_FRAGMENT,
		read: () => served.get(`/${name}`) ?? 0,
	};
}

/// What the editor reads of a recording before its first frame: the head and
/// tail it warms with the size and duration from its sources, the metadata
/// probe, and the first key frame the decoder starts from.
async function openToFirstFrame(file: ReturnType<typeof serve>) {
	mediaSource(file.url, file.size, file.duration, "video/mp4");
	warmMediaSource(file.url, file.size);
	const metadata = await probeBrowserMedia(file.url);
	const lease = await acquireMediaInputAt(file.url, 0);
	try {
		const track = await lease.input.getPrimaryVideoTrack();
		if (!track) throw new Error("no video track");
		const key = await new EncodedPacketSink(track).getKeyPacket(0);
		return { metadata, key };
	} finally {
		lease.release();
	}
}

const MB = 1024 * 1024;

describe("reads of an unindexed recording", () => {
	it("finds the cluster before a far time in WebM audio without cues", async () => {
		// Clusters of unknown size every five seconds, about 16 KB each, as
		// MediaRecorder writes a 128 kbit/s microphone: 30 minutes.
		const mic = webmRecording(360, false, 16, 1000);
		files.set("/mic.webm", mic);
		served.set("/mic.webm", 0);
		const media = new RemoteMedia(`${origin}/mic.webm`, mic.byteLength);
		media.learnContentType("audio/webm");
		media.learnDuration(1800);
		media.warm();
		for (const target of [1624.5, 30.5]) {
			const point = await media.locate(target, undefined, "webm");
			// Audio starts up to 128 KB before the target, a short read on;
			// 45 s of these clusters.
			expect(point?.time).toBeLessThanOrEqual(target);
			expect(target - (point?.time ?? 0)).toBeLessThan(45);
		}
		expect(served.get("/mic.webm")).toBeLessThan(MB);
	});

	it("opens a two-minute and a two-hour recording from the same few reads", async () => {
		const short = serve("short.mp4", { fragments: 60 });
		const long = serve("long.mp4", { fragments: 3600 });
		const shortOpen = await openToFirstFrame(short);
		const longOpen = await openToFirstFrame(long);
		expect(shortOpen.metadata.duration).toBeCloseTo(120, 0);
		expect(longOpen.metadata.duration).toBeCloseTo(7200, 0);
		expect(longOpen.metadata.width).toBe(320);
		expect(shortOpen.key?.timestamp).toBe(0);
		expect(longOpen.key?.timestamp).toBe(0);
		expect(short.read()).toBeLessThan(1.5 * MB);
		expect(long.read()).toBeLessThan(1.5 * MB);
		// Read-ahead into the second fragment may or may not have reached the
		// server yet; it is the only read the two opens can differ by.
		expect(Math.abs(long.read() - short.read())).toBeLessThanOrEqual(
			512 * 1024,
		);
	});

	it("reaches 90% of a two-hour recording from a few reads near it", async () => {
		const long = serve("seek.mp4", { fragments: 3600 });
		await openToFirstFrame(long);
		const before = long.read();
		const target = 6480.5;
		const lease = await acquireMediaInputAt(long.url, target);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const key = await new EncodedPacketSink(track).getKeyPacket(target);
			expect(key?.timestamp).toBe(6480);
		} finally {
			lease.release();
		}
		expect(long.read() - before).toBeLessThan(2 * MB);
	});

	it("opens and seeks a WebM screen recording without cues in a few reads", async () => {
		const clusters = 3600;
		webmRecordings.set("/screen.webm", { clusters });
		served.set("/screen.webm", 0);
		const url = `${origin}/screen.webm`;
		const size = webmInit.byteLength + clusters * WEBM_CLUSTER_BYTES;
		mediaSource(url, size, 7200, "video/webm");
		warmMediaSource(url, size);
		const metadata = await probeBrowserMedia(url);
		expect(metadata.duration).toBeCloseTo(7200, 1);
		expect(metadata.width).toBe(320);
		expect(served.get("/screen.webm")).toBeLessThan(1.5 * MB);
		const opened = served.get("/screen.webm") ?? 0;
		const target = 6480.5;
		const lease = await acquireMediaInputAt(url, target);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const key = await new EncodedPacketSink(track).getKeyPacket(target);
			expect(key?.timestamp).toBe(6480);
		} finally {
			lease.release();
		}
		expect((served.get("/screen.webm") ?? 0) - opened).toBeLessThan(2 * MB);
	});

	it("opens a recording again once storage that failed it is back", async () => {
		const file = serve("flaky.mp4", { fragments: 60 });
		unavailable.add("/flaky.mp4");
		mediaSource(file.url, file.size, file.duration, "video/mp4");
		warmMediaSource(file.url, file.size);
		await expect(probeBrowserMedia(file.url)).rejects.toThrow();
		unavailable.delete("/flaky.mp4");
		const metadata = await probeBrowserMedia(file.url);
		expect(metadata.duration).toBeCloseTo(120, 0);
	});

	it("reads no more when the file ends in an index", async () => {
		const indexed = serve("indexed.mp4", { fragments: 3600, trailer: MFRA });
		const open = await openToFirstFrame(indexed);
		expect(open.metadata.duration).toBeCloseTo(7200, 0);
		expect(indexed.read()).toBeLessThan(1.5 * MB);
	});

	it("ends a recording cut short at its last whole fragment", async () => {
		const cut = serve("cut.mp4", { fragments: 3600, cutBytes: 100_000 });
		const open = await openToFirstFrame(cut);
		expect(open.metadata.duration).toBeCloseTo(7198, 0);
		expect(cut.read()).toBeLessThan(1.5 * MB);
	});
});

/// The index the web recorder appends, built by its own indexer from the
/// bytes it reads of the recording.
function recorderIndex(
	mimeType: string,
	size: number,
	range: (start: number, end: number) => Uint8Array,
) {
	const indexer = createRecordingIndexer(mimeType) as RecordingIndexer;
	while (!indexer.failed && indexer.position < size) {
		const start = indexer.position;
		indexer.push(range(start, Math.min(size, start + indexer.wanted)));
	}
	const index = indexer.finish(size);
	if (!index) throw new Error("the recording took no index");
	return index;
}

describe("reads of a recording with the recorder's index", () => {
	const fragments = 3600;
	const mfra = recorderIndex(
		"video/mp4",
		recordingSize({ fragments }),
		(start, end) => recordingRange({ fragments }, start, end),
	);

	it("opens from the same few reads as one without it", async () => {
		const plain = serve("open-plain.mp4", { fragments });
		const indexed = serve("open-indexed.mp4", { fragments, trailer: mfra });
		await openToFirstFrame(plain);
		const indexedOpen = await openToFirstFrame(indexed);
		expect(indexedOpen.metadata.duration).toBeCloseTo(7200, 0);
		expect(indexedOpen.key?.timestamp).toBe(0);
		expect(Math.abs(indexed.read() - plain.read())).toBeLessThanOrEqual(
			512 * 1024,
		);
	});

	it("finds the key frame before a far time with no reads", async () => {
		const file = serve("located.mp4", { fragments, trailer: mfra });
		await openToFirstFrame(file);
		const media = mediaSource(file.url) as RemoteMedia;
		const before = file.read();
		for (const target of [6480.5, 33, 7199.9]) {
			const point = await media.locate(target);
			expect(point?.time).toBe(Math.floor(target / 2) * 2);
		}
		expect(file.read()).toBe(before);
		const lease = await acquireMediaInputAt(file.url, 6480.5);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const key = await new EncodedPacketSink(track).getKeyPacket(6480.5);
			expect(key?.timestamp).toBe(6480);
		} finally {
			lease.release();
		}
		expect(file.read() - before).toBeLessThan(MB);
	});

	it("takes a Firefox recording's end from its trailer, as from its last cluster", async () => {
		const recorded = new Uint8Array(
			readFileSync(
				new URL(
					"../../../recorder-core/__tests__/fixtures/firefox-av.webm",
					import.meta.url,
				),
			),
		);
		const index = recorderIndex(
			"video/webm",
			recorded.byteLength,
			(start, end) => recorded.subarray(start, end),
		);
		const indexed = new Uint8Array(recorded.byteLength + index.byteLength);
		indexed.set(recorded);
		indexed.set(index, recorded.byteLength);
		const durations = [];
		for (const [name, bytes] of [
			["/firefox.webm", recorded],
			["/firefox-cued.webm", indexed],
		] as const) {
			files.set(name, bytes);
			mediaSource(`${origin}${name}`, bytes.byteLength, 17, "video/webm");
			durations.push((await probeBrowserMedia(`${origin}${name}`)).duration);
		}
		expect(durations[0]).toBeGreaterThan(16.9);
		expect(durations[1]).toBe(durations[0]);
	});

	it("opens and seeks a WebM screen recording from its cues", async () => {
		const clusters = 3600;
		const size = webmInit.byteLength + clusters * WEBM_CLUSTER_BYTES;
		const cues = recorderIndex("video/webm", size, (start, end) =>
			webmRange(clusters, start, end),
		);
		webmRecordings.set("/cued.webm", { clusters, trailer: cues });
		served.set("/cued.webm", 0);
		const url = `${origin}/cued.webm`;
		const total = size + cues.byteLength;
		mediaSource(url, total, 7200, "video/webm");
		warmMediaSource(url, total);
		const metadata = await probeBrowserMedia(url);
		expect(metadata.duration).toBeCloseTo(7200, 1);
		expect(served.get("/cued.webm")).toBeLessThan(1.5 * MB);
		const opened = served.get("/cued.webm") ?? 0;
		const media = mediaSource(url) as RemoteMedia;
		const point = await media.locate(6480.5, undefined, "webm");
		expect(point?.time).toBe(6480);
		expect(served.get("/cued.webm")).toBe(opened);
		const lease = await acquireMediaInputAt(url, 6480.5);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const key = await new EncodedPacketSink(track).getKeyPacket(6480.5);
			expect(key?.timestamp).toBe(6480);
		} finally {
			lease.release();
		}
		expect((served.get("/cued.webm") ?? 0) - opened).toBeLessThan(MB);
	});
});

describe("reads of a Firefox recording's long clusters", () => {
	const clusters = 16;
	const recorded = webmInit.byteLength + clusters * longCluster.byteLength;
	const cues = recorderIndex("video/webm", recorded, (start, end) =>
		longRange(clusters, start, end),
	);
	const size = recorded + cues.byteLength;
	const duration = clusters * LONG_CLUSTER_SECONDS;

	function serveLong(name: string) {
		generated.set(`/${name}`, {
			size,
			range: (start, end) => {
				const out = new Uint8Array(end - start);
				out.set(longRange(clusters, start, Math.min(end, recorded)));
				if (end > recorded) {
					const from = Math.max(start, recorded);
					out.set(cues.subarray(from - recorded, end - recorded), from - start);
				}
				return out;
			},
		});
		served.set(`/${name}`, 0);
		const url = `${origin}/${name}`;
		return { url, read: () => served.get(`/${name}`) ?? 0 };
	}

	async function packetsFrom(
		sink: EncodedPacketSink,
		from: number,
		count: number,
	) {
		const out: string[] = [];
		let packet: EncodedPacket | null = await sink.getKeyPacket(from);
		while (packet && out.length < count) {
			out.push(
				`${packet.timestamp.toFixed(3)} ${packet.type} ${packet.byteLength}`,
			);
			packet = await sink.getNextPacket(packet);
		}
		return out;
	}

	it("opens to its first frame from the key frame, not the whole first cluster", async () => {
		const file = serveLong("long-open.webm");
		mediaSource(file.url, size, duration, "video/webm");
		warmMediaSource(file.url, size);
		const metadata = await probeBrowserMedia(file.url);
		expect(metadata.duration).toBeCloseTo(duration, 0);
		const lease = await acquireMediaInputAt(file.url, 0);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const sink = new EncodedPacketSink(track);
			expect((await sink.getKeyPacket(0))?.byteLength).toBe(LONG_KEY_BYTES);
			expect((await sink.getPacket(0.05))?.timestamp).toBeCloseTo(0.033, 3);
		} finally {
			lease.release();
		}
		// The head and tail every file reads, then the rest of the key frame
		// and the frames after it the decoder needs: a sixth of the cluster
		// mediabunny would otherwise load before the first frame.
		const pinned =
			firstHeadBytes(size, duration) + firstTailBytes(size, duration);
		expect(file.read() - pinned).toBeLessThan(longCluster.byteLength / 6);
	});

	it("seeks into a cluster reading only up to the frame it wants", async () => {
		const file = serveLong("long-seek.webm");
		mediaSource(file.url, size, duration, "video/webm");
		warmMediaSource(file.url, size);
		await probeBrowserMedia(file.url);
		const media = mediaSource(file.url) as RemoteMedia;
		const target = 14 * LONG_CLUSTER_SECONDS + 1.2;
		expect((await media.locate(target, undefined, "webm"))?.time).toBe(105);
		const before = file.read();
		const lease = await acquireMediaInputAt(file.url, target);
		try {
			const track = await lease.input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const sink = new EncodedPacketSink(track);
			expect((await sink.getKeyPacket(target))?.timestamp).toBe(105);
			expect((await sink.getPacket(target))?.timestamp).toBeCloseTo(106.2, 3);
		} finally {
			lease.release();
		}
		// The frame 1.2 s in sits 760 KB into a 2.6 MB cluster: the cut reads
		// its estimate and, when that falls short, as much again.
		expect(file.read() - before).toBeLessThan(1.25 * MB);
		expect(longCluster.byteLength).toBeGreaterThan(2.5 * MB);
	});

	it("plays on across the cut and finds key frames as the whole file does", async () => {
		const file = serveLong("long-play.webm");
		mediaSource(file.url, size, duration, "video/webm");
		warmMediaSource(file.url, size);
		await probeBrowserMedia(file.url);
		const reference = new Input({
			formats: ALL_FORMATS,
			source: new UrlSource(file.url),
		});
		const referenceTrack = await reference.getPrimaryVideoTrack();
		if (!referenceTrack) throw new Error("no reference track");
		const expected = new EncodedPacketSink(referenceTrack);
		for (const target of [0, 37.7, 104.99]) {
			const lease = await acquireMediaInputAt(file.url, target);
			try {
				const track = await lease.input.getPrimaryVideoTrack();
				if (!track) throw new Error("no video track");
				const sink = new EncodedPacketSink(track);
				expect(await packetsFrom(sink, target, 300)).toEqual(
					await packetsFrom(expected, target, 300),
				);
				for (const later of [target + 2, target + 6, target + 7.6]) {
					expect((await sink.getKeyPacket(later))?.timestamp).toBe(
						(await expected.getKeyPacket(later))?.timestamp,
					);
					expect((await sink.getPacket(later))?.timestamp).toBe(
						(await expected.getPacket(later))?.timestamp,
					);
				}
			} finally {
				lease.release();
			}
		}
		reference.dispose();
	});
});
