import { readFileSync } from "node:fs";
import {
	createRecordingIndexer,
	indexBlob,
	type RecordingIndexer,
	webmCuesTrailerBytes,
} from "@cap/recorder-core/recording-index";
import { describe, expect, it } from "vitest";

// Real MediaRecorder output (fake capture devices, 160x120), with the sizes of
// the chunks each recorder emitted at a one-second timeslice.
const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const recordings = {
	chromeMp4: {
		bytes: fixture("chrome-av.mp4"),
		mimeType: 'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
		chunks: [1251, 63804, 35945, 17372],
	},
	chromeAudioMp4: {
		bytes: fixture("chrome-mic.mp4"),
		mimeType: "audio/mp4;codecs=mp4a.40.2",
		chunks: [667, 8465, 3222, 4571],
	},
	chromeAudioWebm: {
		bytes: fixture("chrome-mic.webm"),
		mimeType: "audio/webm;codecs=opus",
		chunks: [4007, 8278, 8278, 8278, 7791],
	},
	firefoxAudioWebm: {
		bytes: fixture("firefox-mic.webm"),
		mimeType: "audio/webm;codecs=opus",
		chunks: [8935, 8516, 8516, 8516, 8516, 186],
	},
	firefoxWebm: {
		bytes: fixture("firefox-av.webm"),
		mimeType: "video/webm;codecs=vp8,opus",
		chunks: [
			5948, 5401, 5362, 5443, 5568, 5525, 5298, 5597, 5434, 5385, 5584, 5249,
			5531, 5374, 5647, 5419, 3686,
		],
	},
};

type Recording = (typeof recordings)[keyof typeof recordings];

function split(bytes: Uint8Array<ArrayBuffer>, sizes: number[]) {
	const out: Uint8Array<ArrayBuffer>[] = [];
	let at = 0;
	for (const size of sizes) {
		out.push(bytes.subarray(at, at + size));
		at += size;
	}
	if (at < bytes.byteLength) out.push(bytes.subarray(at));
	return out;
}

async function indexChunks(
	mimeType: string,
	chunks: Uint8Array<ArrayBuffer>[],
) {
	const indexer = createRecordingIndexer(mimeType) as RecordingIndexer;
	let start = 0;
	for (const chunk of chunks) {
		await indexBlob(indexer, new Blob([chunk]), start);
		start += chunk.byteLength;
	}
	return indexer.finish(start);
}

const indexed = (recording: Recording) =>
	indexChunks(recording.mimeType, split(recording.bytes, recording.chunks));

function readMfra(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = (at: number) =>
		String.fromCharCode(...bytes.subarray(at + 4, at + 8));
	expect(type(0)).toBe("mfra");
	expect(view.getUint32(0)).toBe(bytes.byteLength);
	expect(type(bytes.byteLength - 16)).toBe("mfro");
	expect(view.getUint32(bytes.byteLength - 4)).toBe(bytes.byteLength);
	expect(type(8)).toBe("tfra");
	expect(8 + view.getUint32(8) + 16).toBe(bytes.byteLength);
	const version = view.getUint8(16);
	const lengths = view.getUint32(24);
	const sizes = [(lengths >> 4) & 3, (lengths >> 2) & 3, lengths & 3].map(
		(code) => code + 1,
	);
	const uint = (at: number, length: number) => {
		let value = 0;
		for (let index = 0; index < length; index++)
			value = value * 256 + (bytes[at + index] ?? 0);
		return value;
	};
	const entries = [];
	let at = 32;
	for (let index = 0; index < view.getUint32(28); index++) {
		const time =
			version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
		const moof =
			version === 1
				? Number(view.getBigUint64(at + 8))
				: view.getUint32(at + 4);
		at += version === 1 ? 16 : 8;
		const [traf = 1, trun = 1, sample = 1] = sizes.map((size) => {
			const value = uint(at, size);
			at += size;
			return value;
		});
		entries.push({ time, moof, traf, trun, sample });
	}
	expect(at).toBe(bytes.byteLength - 16);
	return { trackId: view.getUint32(20), version, entries };
}

function readEnds(trailer: Uint8Array) {
	const view = new DataView(
		trailer.buffer,
		trailer.byteOffset,
		trailer.byteLength,
	);
	const tracks = trailer[trailer.byteLength - 9] ?? 0;
	const length = trailer.byteLength - webmCuesTrailerBytes(tracks);
	expect([...trailer.subarray(length, length + 6)]).toEqual([
		0xec,
		0x80 | (webmCuesTrailerBytes(tracks) - 2),
		0x63,
		0x75,
		0x65,
		0x73,
	]);
	expect(Number(view.getBigUint64(trailer.byteLength - 8))).toBe(length);
	const ends: Record<number, number> = {};
	for (let index = 0; index < tracks; index++) {
		const at = length + 6 + index * 9;
		ends[trailer[at] ?? 0] = Number(view.getBigUint64(at + 1));
	}
	return { length, ends };
}

function readCues(trailer: Uint8Array) {
	const { length } = readEnds(trailer);
	expect([...trailer.subarray(0, 5)]).toEqual([0x1c, 0x53, 0xbb, 0x6b, 0x01]);
	const uint = (at: number, size: number) => {
		let value = 0;
		for (let index = 0; index < size; index++)
			value = value * 256 + (trailer[at + index] ?? 0);
		return value;
	};
	expect(uint(5, 7)).toBe(length - 12);
	const cues = [];
	let at = 12;
	while (at < length) {
		expect(trailer[at]).toBe(0xbb);
		const end = at + 2 + ((trailer[at + 1] ?? 0) & 0x7f);
		let time = -1;
		let track = -1;
		let cluster = -1;
		for (let field = at + 2; field < end; ) {
			const id = trailer[field] ?? 0;
			const size = (trailer[field + 1] ?? 0) & 0x7f;
			if (id === 0xb3) time = uint(field + 2, size);
			if (id === 0xb7) {
				for (let inner = field + 2; inner < field + 2 + size; ) {
					const innerSize = (trailer[inner + 1] ?? 0) & 0x7f;
					if (trailer[inner] === 0xf7) track = uint(inner + 2, innerSize);
					if (trailer[inner] === 0xf1) cluster = uint(inner + 2, innerSize);
					inner += 2 + innerSize;
				}
			}
			field += 2 + size;
		}
		cues.push({ time, track, cluster });
		at = end;
	}
	return cues;
}

describe("Mp4Indexer", () => {
	it("lists the fragment of every video key frame of a Chrome recording", async () => {
		const mfra = await indexed(recordings.chromeMp4);
		expect(mfra).not.toBeNull();
		expect(readMfra(mfra as Uint8Array)).toEqual({
			trackId: 2,
			version: 0,
			entries: [
				{ time: 0, moof: 1251, traf: 2, trun: 1, sample: 1 },
				{ time: 40769, moof: 33342, traf: 2, trun: 1, sample: 1 },
				{ time: 80770, moof: 65055, traf: 2, trun: 1, sample: 1 },
				{ time: 120777, moof: 101000, traf: 2, trun: 1, sample: 1 },
			],
		});
	});

	it("indexes an audio-only recording by its audio track", async () => {
		const mfra = await indexed(recordings.chromeAudioMp4);
		const { trackId, entries } = readMfra(mfra as Uint8Array);
		expect(trackId).toBe(1);
		expect(entries.map((entry) => entry.moof)).toEqual([
			667, 2559, 5795, 9132, 12354,
		]);
		expect(entries.map((entry) => entry.time)).toEqual([
			0, 49152, 97279, 145407, 193536,
		]);
	});

	it("builds the same index however the bytes are split", async () => {
		const { bytes, mimeType } = recordings.chromeMp4;
		const expected = await indexed(recordings.chromeMp4);
		for (const size of [1, 7, 1000, 4096]) {
			const sizes = Array.from(
				{ length: Math.ceil(bytes.byteLength / size) },
				() => size,
			);
			expect(await indexChunks(mimeType, split(bytes, sizes))).toEqual(
				expected,
			);
		}
		expect(await indexChunks(mimeType, [bytes])).toEqual(expected);
	});

	it("leaves a recording cut inside a fragment without an index", async () => {
		const { bytes, mimeType } = recordings.chromeMp4;
		expect(await indexChunks(mimeType, [bytes.subarray(0, 90_000)])).toBeNull();
		const cut = await indexChunks(mimeType, [bytes.subarray(0, 101_000)]);
		expect(
			readMfra(cut as Uint8Array).entries.map((entry) => entry.moof),
		).toEqual([1251, 33342, 65055]);
	});

	it("does not index a recording that already ends in an index", async () => {
		const { bytes, mimeType } = recordings.chromeMp4;
		const mfra = (await indexed(recordings.chromeMp4)) as Uint8Array;
		const whole = new Uint8Array(bytes.byteLength + mfra.byteLength);
		whole.set(bytes);
		whole.set(mfra, bytes.byteLength);
		expect(await indexChunks(mimeType, [whole])).toBeNull();
	});

	it("does not index bytes that are not a fragmented MP4", async () => {
		const { bytes } = recordings.firefoxWebm;
		expect(await indexChunks("video/mp4", [bytes])).toBeNull();
	});
});

describe("WebmIndexer", () => {
	it("ends with each track's last block time", async () => {
		const firefox = (await indexed(recordings.firefoxWebm)) as Uint8Array;
		const chrome = (await indexed(recordings.chromeAudioWebm)) as Uint8Array;
		expect(readEnds(firefox).ends).toEqual({ 1: 16972, 2: 17006 });
		expect(readEnds(chrome).ends).toEqual({ 1: 4920 });
	});

	it("cues every key frame cluster of a Firefox recording", async () => {
		const trailer = (await indexed(recordings.firefoxWebm)) as Uint8Array;
		expect(readCues(trailer)).toEqual([
			{ time: 0, track: 1, cluster: 312 - 55 },
			{ time: 7458, track: 1, cluster: 40159 - 55 },
			{ time: 14936, track: 1, cluster: 80304 - 55 },
		]);
	});

	it("cues an audio-only recording a few seconds apart", async () => {
		const trailer = (await indexed(recordings.chromeAudioWebm)) as Uint8Array;
		expect(readCues(trailer)).toEqual([{ time: 0, track: 1, cluster: 98 }]);
	});

	it("cues a Firefox audio recording, whose blocks carry no key flag", async () => {
		const trailer = (await indexed(recordings.firefoxAudioWebm)) as Uint8Array;
		expect(readCues(trailer)).toEqual([
			{ time: 6, track: 2, cluster: 260 - 55 },
		]);
	});

	it("builds the same cues however the bytes are split", async () => {
		const { bytes, mimeType } = recordings.firefoxWebm;
		const expected = await indexed(recordings.firefoxWebm);
		for (const size of [1, 5, 333, 65536]) {
			const sizes = Array.from(
				{ length: Math.ceil(bytes.byteLength / size) },
				() => size,
			);
			expect(await indexChunks(mimeType, split(bytes, sizes))).toEqual(
				expected,
			);
		}
	});

	it("leaves a recording cut inside a block without cues", async () => {
		const { bytes, mimeType } = recordings.firefoxWebm;
		expect(
			await indexChunks(mimeType, [bytes.subarray(0, bytes.byteLength - 3)]),
		).toBeNull();
	});

	it("does not cue a recording that already has cues", async () => {
		const { bytes, mimeType } = recordings.firefoxWebm;
		const trailer = (await indexed(recordings.firefoxWebm)) as Uint8Array;
		const whole = new Uint8Array(bytes.byteLength + trailer.byteLength);
		whole.set(bytes);
		whole.set(trailer, bytes.byteLength);
		expect(await indexChunks(mimeType, [whole])).toBeNull();
	});

	it("does not cue bytes that are not a WebM", async () => {
		const { bytes } = recordings.chromeMp4;
		expect(await indexChunks("video/webm", [bytes])).toBeNull();
	});
});
