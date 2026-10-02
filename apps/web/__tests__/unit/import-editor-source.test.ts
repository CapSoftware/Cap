import { describe, expect, it } from "vitest";
import {
	type ImportMediaFacts,
	importEditorSourcePlan,
	importEditorSourcesPatch,
	isobmffLayout,
} from "@/lib/import-editor-source";

const video = {
	codec: "avc",
	codecString: "avc1.640028",
	width: 1920,
	height: 1080,
	rotation: 0,
	squarePixels: true,
	firstTimestamp: 0,
	packetRate: 29.97,
	decodable: true,
};
const audio = { codec: "aac", firstTimestamp: 0, decodable: true };
const facts = (
	overrides: Partial<ImportMediaFacts> = {},
): ImportMediaFacts => ({
	container: "mp4",
	layout: "faststart",
	duration: 30.5,
	videoTracks: [video],
	audioTracks: [audio],
	...overrides,
});

describe("importEditorSourcePlan", () => {
	it("opens an H.264 and AAC MP4 or MOV from its upload", () => {
		expect(importEditorSourcePlan(facts())).toEqual({
			duration: 30.5,
			fps: 30,
		});
		expect(
			importEditorSourcePlan(
				facts({ container: "quicktime", audioTracks: [] }),
			),
		).toEqual({ duration: 30.5, fps: 30 });
		expect(
			importEditorSourcePlan(
				facts({ videoTracks: [{ ...video, codecString: "avc1.42E01E" }] }),
			),
		).not.toBeNull();
	});

	it.each([
		["another container", facts({ container: "other" })],
		["a fragmented file", facts({ layout: "fragmented" })],
		["an index at the end", facts({ layout: "index-at-end" })],
		["an unreadable layout", facts({ layout: "unknown" })],
		["no video", facts({ videoTracks: [] })],
		["two video tracks", facts({ videoTracks: [video, video] })],
		["two audio tracks", facts({ audioTracks: [audio, audio] })],
		[
			"HEVC",
			facts({
				videoTracks: [
					{ ...video, codec: "hevc", codecString: "hvc1.1.6.L93.B0" },
				],
			}),
		],
		[
			"10-bit H.264",
			facts({ videoTracks: [{ ...video, codecString: "avc1.6E0028" }] }),
		],
		[
			"4:4:4 H.264",
			facts({ videoTracks: [{ ...video, codecString: "avc1.F40028" }] }),
		],
		[
			"undecodable video",
			facts({ videoTracks: [{ ...video, decodable: false }] }),
		],
		["rotated video", facts({ videoTracks: [{ ...video, rotation: 90 }] })],
		[
			"non-square pixels",
			facts({ videoTracks: [{ ...video, squarePixels: false }] }),
		],
		[
			"8K video",
			facts({ videoTracks: [{ ...video, width: 7680, height: 4320 }] }),
		],
		[
			"late video start",
			facts({ videoTracks: [{ ...video, firstTimestamp: 0.5 }] }),
		],
		[
			"negative video start",
			facts({ videoTracks: [{ ...video, firstTimestamp: -0.02 }] }),
		],
		["Opus audio", facts({ audioTracks: [{ ...audio, codec: "opus" }] })],
		[
			"undecodable audio",
			facts({ audioTracks: [{ ...audio, decodable: false }] }),
		],
		["offset audio", facts({ audioTracks: [{ ...audio, firstTimestamp: 1 }] })],
		[
			"too high a frame rate",
			facts({ videoTracks: [{ ...video, packetRate: 240 }] }),
		],
		[
			"no frame rate",
			facts({ videoTracks: [{ ...video, packetRate: Number.NaN }] }),
		],
		["no duration", facts({ duration: 0 })],
	])("waits for processing on %s", (_, input) => {
		expect(importEditorSourcePlan(input)).toBeNull();
	});
});

describe("importEditorSourcesPatch", () => {
	const input = {
		ownerId: "owner",
		videoId: "video",
		isPro: true,
		source: { duration: 42.25, fps: 30 },
		upload: { phase: "uploading", rawFileKey: "owner/video/raw-upload.mp4" },
		existingSources: undefined,
		head: { size: 1234, identity: '"etag"' },
	};

	it("registers the verified upload as the editor's display source", () => {
		expect(importEditorSourcesPatch(input)).toEqual({
			duration: 42.25,
			editorSources: {
				version: 1,
				display: {
					key: "owner/video/raw-upload.mp4",
					contentType: "video/mp4",
					size: 1234,
					fps: 30,
					objectIdentity: '"etag"',
					embeddedAudio: true,
				},
			},
		});
	});

	it.each([
		["an invalid source", { source: { duration: 10, fps: 30.5 } }],
		[
			"a Free import over the plan length",
			{ isPro: false, source: { duration: 301, fps: 30 } },
		],
		[
			"another upload key",
			{ upload: { phase: "uploading", rawFileKey: "owner/video/result.mp4" } },
		],
		[
			"an upload already processing",
			{
				upload: {
					phase: "processing",
					rawFileKey: "owner/video/raw-upload.mp4",
				},
			},
		],
		["no upload row", { upload: null }],
		["existing sources", { existingSources: { version: 1 } }],
		["an empty object", { head: { size: 0, identity: '"etag"' } }],
		["an unidentified object", { head: { size: 1234, identity: undefined } }],
	])("leaves %s to processing", (_, overrides) => {
		expect(importEditorSourcesPatch({ ...input, ...overrides })).toBeNull();
	});

	it("keeps a short Free import eligible", () => {
		expect(
			importEditorSourcesPatch({
				...input,
				isPro: false,
				source: { duration: 120, fps: 60 },
			}),
		).not.toBeNull();
	});
});

function box(type: string, body: Uint8Array | number = 0) {
	const content = typeof body === "number" ? new Uint8Array(body) : body;
	const bytes = new Uint8Array(8 + content.byteLength);
	new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
	bytes.set(
		[...type].map((c) => c.charCodeAt(0)),
		4,
	);
	bytes.set(content, 8);
	return bytes;
}

function largeBox(type: string, size: number) {
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 1);
	bytes.set(
		[...type].map((c) => c.charCodeAt(0)),
		4,
	);
	view.setBigUint64(8, BigInt(size));
	return bytes;
}

function concat(...parts: Uint8Array[]) {
	const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

function layout(bytes: Uint8Array, size = bytes.byteLength) {
	const reads: Array<[number, number]> = [];
	return {
		reads,
		result: isobmffLayout(async (start, end) => {
			reads.push([start, end]);
			return bytes.subarray(start, Math.min(end, bytes.byteLength));
		}, size),
	};
}

describe("isobmffLayout", () => {
	const moov = box("moov", concat(box("mvhd", 100), box("trak", 64)));

	it("finds a faststart index without reading the media", async () => {
		const { result, reads } = layout(
			concat(box("ftyp", 16), moov, box("mdat", 4096)),
		);
		await expect(result).resolves.toBe("faststart");
		expect(reads.every(([start, end]) => end - start <= 16)).toBe(true);
	});

	it("finds an index after the media, skipping it by size", async () => {
		const { result, reads } = layout(
			concat(box("ftyp", 16), box("mdat", 4096), moov),
		);
		await expect(result).resolves.toBe("index-at-end");
		expect(reads.every(([start, end]) => end - start <= 16)).toBe(true);
		const header = largeBox("mdat", 16 + 4096);
		await expect(
			layout(concat(box("ftyp", 16), header, new Uint8Array(4096), moov))
				.result,
		).resolves.toBe("index-at-end");
	});

	it("flags fragmented and indexed layouts", async () => {
		const fragmentedMoov = box(
			"moov",
			concat(box("mvhd", 100), box("trak", 64), box("mvex", 32)),
		);
		for (const file of [
			concat(box("ftyp", 16), fragmentedMoov, box("moof", 32), box("mdat", 64)),
			concat(box("ftyp", 16), box("moof", 32), box("mdat", 64)),
			concat(box("ftyp", 16), box("sidx", 32), moov),
		]) {
			await expect(layout(file).result).resolves.toBe("fragmented");
		}
	});

	it("gives up on a truncated or index-less file", async () => {
		const noIndex = concat(box("ftyp", 16), box("mdat", 64));
		await expect(layout(noIndex).result).resolves.toBe("unknown");
		await expect(layout(noIndex, noIndex.byteLength + 4).result).resolves.toBe(
			"unknown",
		);
		const corrupt = concat(
			box("ftyp", 16),
			new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]),
		);
		await expect(layout(corrupt).result).resolves.toBe("unknown");
	});
});
