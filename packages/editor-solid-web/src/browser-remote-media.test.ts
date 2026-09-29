import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ALL_FORMATS,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
	UrlSource,
} from "mediabunny";
import { layoutRetryDelay } from "./browser-media-inputs";
import {
	firstTailBytes,
	layoutFetch,
	MediaStorageError,
	RemoteMedia,
	rangeResponseExtent,
} from "./browser-remote-media";
import { concat, fragment, init } from "./fragmented-mp4-fixtures";

const URL_ = "https://storage.test/recording.mp4";
let file: Uint8Array<ArrayBuffer> = new Uint8Array(0);
let requests: string[] = [];
const realFetch = globalThis.fetch;

type Serving = {
	/// Status for a ranged request, or null to serve it normally.
	status?: (start: number) => number | null;
	/// Drop these headers from 206 responses.
	omit?: string[];
};

function serve(bytes: Uint8Array, serving: Serving = {}) {
	file = bytes.slice();
	requests = [];
	globalThis.fetch = (async (
		_input: RequestInfo | URL,
		request?: RequestInit,
	) => {
		const range = new Headers(request?.headers).get("Range") ?? "";
		requests.push(range);
		const match = /^bytes=(\d+)-(\d*)$/.exec(range);
		if (!match) return new Response(file, { status: 200 });
		const start = Number(match[1]);
		const status = serving.status?.(start) ?? null;
		if (status === 200) return new Response(file, { status: 200 });
		if (status !== null) return new Response("denied", { status });
		const end = Math.min(
			file.length,
			match[2] ? Number(match[2]) + 1 : file.length,
		);
		const headers = new Headers({
			"Content-Range": `bytes ${start}-${end - 1}/${file.length}`,
			"Content-Length": String(end - start),
		});
		for (const name of serving.omit ?? []) headers.delete(name);
		return new Response(file.slice(start, end), { status: 206, headers });
	}) as typeof fetch;
}

async function bytesOf(body: ReadableStream<Uint8Array>) {
	return new Uint8Array(await new Response(body).arrayBuffer());
}

/// A two-hour-like recording: 2 s fragments of about 40 KB each.
function longRecording(fragments: number) {
	const parts = [init()];
	for (let index = 0; index < fragments; index++) {
		parts.push(
			fragment(index * 2 * 15360, {
				payload: 38_000 + ((index * 7919) % 9000),
			}),
		);
	}
	return concat(...parts);
}

/// A real fragmented H.264 MP4 (a minute at 30 fps, one fragment a second)
/// for tests that go through mediabunny's demuxer.
async function muxedRecording() {
	const output = new Output({
		format: new Mp4OutputFormat({
			fastStart: "fragmented",
			minimumFragmentDuration: 1,
		}),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource("avc");
	output.addVideoTrack(source, { frameRate: 30 });
	await output.start();
	const description = new Uint8Array([
		1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1f, 1, 0, 4, 0x68,
		0xce, 0x3c, 0x80,
	]);
	for (let index = 0; index < 30 * 60; index++) {
		await source.add(
			new EncodedPacket(
				new Uint8Array(2000).fill(index % 255),
				index % 30 === 0 ? "key" : "delta",
				index / 30,
				1 / 30,
			),
			index === 0
				? {
						decoderConfig: {
							codec: "avc1.42001f",
							codedWidth: 320,
							codedHeight: 240,
							description,
						},
					}
				: undefined,
		);
	}
	await output.finalize();
	const buffer = (output.target as BufferTarget).buffer;
	if (!buffer) throw new Error("muxer wrote nothing");
	return new Uint8Array(buffer);
}

beforeEach(() => serve(new Uint8Array(0)));
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("firstTailBytes", () => {
	test("sizes the first tail read to a few seconds of media", () => {
		expect(firstTailBytes(null, null)).toBe(256 * 1024);
		expect(firstTailBytes(900_000_000, 7200)).toBe(512 * 1024);
		expect(firstTailBytes(10_000_000, 120)).toBe(384 * 1024);
		expect(firstTailBytes(9_000_000_000, 60)).toBe(4 * 1024 * 1024);
	});
});

describe("RemoteMedia", () => {
	test("serves reads inside the head and tail from memory", async () => {
		serve(longRecording(40));
		const media = new RemoteMedia(URL_, file.length);
		media.warm();
		const [head] = await Promise.all([media.head(), media.tail(256 * 1024)]);
		expect(head?.byteLength).toBe(512 * 1024);
		const before = requests.length;
		const inside = await media.read(1000, 5000);
		expect(await bytesOf(inside.body)).toEqual(file.slice(1000, 5000));
		const tail = await media.read(file.length - 100, file.length);
		expect(await bytesOf(tail.body)).toEqual(file.slice(file.length - 100));
		expect(requests.length).toBe(before);
	});

	test("stops a network read at the start of a pinned block", async () => {
		serve(longRecording(40));
		const media = new RemoteMedia(URL_, file.length);
		await media.tail(256 * 1024);
		const tailStart = file.length - 256 * 1024;
		const response = await media.read(tailStart - 1000, file.length);
		expect(response.end).toBe(tailStart);
		expect(requests.at(-1)).toBe(`bytes=${tailStart - 1000}-${tailStart - 1}`);
	});

	test("locates a keyframe fragment just before a far target in few reads", async () => {
		serve(longRecording(3600));
		const media = new RemoteMedia(URL_, file.length);
		media.warm();
		const point = await media.locate(5000);
		expect(point).not.toBeNull();
		if (!point) return;
		expect(point.time).toBeLessThanOrEqual(5000);
		expect(5000 - point.time).toBeLessThan(60);
		expect(
			new TextDecoder().decode(
				file.subarray(point.offset + 4, point.offset + 8),
			),
		).toBe("moof");
		const probes = requests.filter((range) => /-\d+$/.test(range)).length;
		expect(probes).toBeLessThan(12);
	});

	test("maps a region layout onto the init bytes and the fragment", async () => {
		serve(longRecording(100));
		const media = new RemoteMedia(URL_, file.length);
		const point = await media.locate(100);
		if (!point) throw new Error("no fragment");
		const layout = await media.layout(point.offset);
		const read = layoutFetch(media, layout);
		const first = await read(URL_, { headers: { Range: "bytes=0-" } });
		expect(first.status).toBe(206);
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(init());
		const next = await read(URL_, {
			headers: { Range: `bytes=${init().byteLength}-` },
		});
		const range = next.headers.get("Content-Range") ?? "";
		const total = Number(range.split("/")[1]);
		expect(total).toBe(init().byteLength + (file.length - point.offset) + 24);
		const body = new Uint8Array(await next.arrayBuffer());
		expect(body.subarray(0, 64)).toEqual(
			file.subarray(point.offset, point.offset + 64),
		);
		const trailer = await read(URL_, {
			headers: { Range: `bytes=${total - 24}-` },
		});
		expect(
			new TextDecoder().decode(
				new Uint8Array(await trailer.arrayBuffer()).subarray(4, 8),
			),
		).toBe("mfra");
	});
});

describe("rangeResponseExtent", () => {
	const headers = (values: Record<string, string>) => new Headers(values);

	test("takes the end and size from Content-Range", () => {
		expect(
			rangeResponseExtent(
				headers({ "Content-Range": "bytes 100-199/1000" }),
				100,
				200,
				null,
			),
		).toEqual({ end: 200, size: 1000 });
		expect(
			rangeResponseExtent(
				headers({
					"Content-Range": "bytes 100-149/1000",
					"Content-Length": "50",
				}),
				100,
				200,
				null,
			),
		).toEqual({ end: 150, size: 1000 });
	});

	test("falls back to Content-Length and the known size without Content-Range", () => {
		expect(
			rangeResponseExtent(headers({ "Content-Length": "100" }), 100, 200, 1000),
		).toEqual({ end: 200, size: 1000 });
		expect(
			rangeResponseExtent(headers({ "Content-Length": "100" }), 100, 200, null),
		).toBeNull();
	});

	test("rejects responses that would read nothing or the wrong bytes", () => {
		expect(rangeResponseExtent(headers({}), 100, 200, 1000)).toBeNull();
		expect(
			rangeResponseExtent(headers({ "Content-Length": "0" }), 100, 200, 1000),
		).toBeNull();
		expect(
			rangeResponseExtent(
				headers({ "Content-Range": "bytes 0-99/1000" }),
				100,
				200,
				1000,
			),
		).toBeNull();
		expect(
			rangeResponseExtent(
				headers({
					"Content-Range": "bytes 100-199/1000",
					"Content-Length": "40",
				}),
				100,
				200,
				null,
			),
		).toBeNull();
		expect(
			rangeResponseExtent(
				headers({ "Content-Range": "bytes 100-299/1000" }),
				100,
				200,
				null,
			),
		).toBeNull();
	});
});

describe("storage that misbehaves", () => {
	test("reads ranges whose Content-Length or Content-Range is hidden", async () => {
		serve(longRecording(20), { omit: ["Content-Length"] });
		let media = new RemoteMedia(URL_, null);
		let response = await media.read(1000, 3000);
		expect(await bytesOf(response.body)).toEqual(file.slice(1000, 3000));
		serve(longRecording(20), { omit: ["Content-Range"] });
		media = new RemoteMedia(URL_, file.length);
		response = await media.read(1000, 3000);
		expect(response.end).toBe(3000);
		expect(await bytesOf(response.body)).toEqual(file.slice(1000, 3000));
	});

	test("reports an error status or an ignored range as a storage error", async () => {
		serve(longRecording(20), { status: () => 403 });
		const media = new RemoteMedia(URL_, file.length);
		await expect(media.read(1000, 3000)).rejects.toBeInstanceOf(
			MediaStorageError,
		);
		expect(await media.head().catch(() => null)).toBeNull();
		serve(longRecording(20), { status: () => 200 });
		const ignored = new RemoteMedia(URL_, file.length);
		const error = await ignored.read(1000, 3000).catch((cause) => cause);
		expect(error).toBeInstanceOf(MediaStorageError);
		expect(error.status).toBe(502);
	});

	test("does not remember a failed head read", async () => {
		serve(longRecording(20), { status: () => 503 });
		const media = new RemoteMedia(URL_, file.length);
		expect(await media.head().catch(() => null)).toBeNull();
		serve(longRecording(20));
		expect((await media.head())?.byteLength).toBeGreaterThan(0);
	});

	test("layout reads answer with the storage status instead of throwing", async () => {
		serve(longRecording(100));
		const media = new RemoteMedia(URL_, file.length);
		const layout = await media.layout(null);
		const read = layoutFetch(media, layout);
		serve(file, { status: (start) => (start > 600_000 ? 403 : null) });
		const denied = await read(URL_, {
			headers: { Range: "bytes=2000000-" },
		});
		expect(denied.status).toBe(403);
		serve(file, { status: (start) => (start > 600_000 ? 200 : null) });
		const ignored = await read(URL_, {
			headers: { Range: "bytes=2100000-" },
		});
		expect(ignored.status).toBe(502);
	});

	test("never retries a storage error", () => {
		expect(layoutRetryDelay(1, new MediaStorageError(403))).toBeNull();
		expect(layoutRetryDelay(1, new TypeError("network"))).toBe(0.5);
		expect(layoutRetryDelay(4, new TypeError("network"))).toBeNull();
	});

	test("a decoder reading through a denied range fails instead of waiting", async () => {
		serve(await muxedRecording());
		const media = new RemoteMedia(URL_, file.length);
		const layout = await media.layout(null);
		serve(file, { status: (start) => (start > 700_000 ? 403 : null) });
		const input = new Input({
			formats: ALL_FORMATS,
			source: new UrlSource(URL_, {
				fetchFn: layoutFetch(media, layout) as typeof fetch,
				getRetryDelay: layoutRetryDelay,
			}),
		});
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error("no video track");
			const outcome = await Promise.race([
				new EncodedPacketSink(track).getKeyPacket(50).then(
					() => "read",
					() => "failed",
				),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
			]);
			expect(outcome).toBe("failed");
		} finally {
			input.dispose();
		}
	});
});
