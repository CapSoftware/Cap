import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InstantRecordingUploader } from "@cap/recorder-core/instant-mp4-uploader";
import type { VideoId } from "@cap/recorder-core/recorder-types";
import {
	createRecordingIndexer,
	indexBlob,
} from "@cap/recorder-core/recording-index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real MediaRecorder output and the chunk sizes the recorder emitted.
const fixtures = join(
	__dirname,
	"../../../../packages/recorder-core/__tests__/fixtures",
);
const recordings = [
	{
		file: "chrome-av.mp4",
		mimeType: 'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
		subpath: "raw-upload.mp4",
		chunks: [1251, 63804, 35945, 17372],
	},
	{
		file: "firefox-av.webm",
		mimeType: "video/webm;codecs=vp8,opus",
		subpath: "raw-upload.webm",
		chunks: [
			5948, 5401, 5362, 5443, 5568, 5525, 5298, 5597, 5434, 5385, 5584, 5249,
			5531, 5374, 5647, 5419, 3686,
		],
	},
];

class RecordingXMLHttpRequest {
	static parts: { url: string; body: Blob; range: string | null }[] = [];
	upload = {
		onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	timeout = 0;
	responseType = "";
	private url = "";
	private readonly headers = new Map<string, string>();

	open(_method: string, url: string) {
		this.url = url;
	}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}

	getResponseHeader(name: string) {
		return name.toLowerCase() === "etag" ? `"etag-${this.url}"` : null;
	}

	send(body: Blob) {
		RecordingXMLHttpRequest.parts.push({
			url: this.url,
			body,
			range: this.headers.get("content-range") ?? null,
		});
		this.status = 200;
		queueMicrotask(() => this.onload?.());
	}

	abort() {}
}

let completed: { partNumber: number; size: number }[] = [];
let provider: "s3" | "googleDrive" = "s3";

beforeEach(() => {
	RecordingXMLHttpRequest.parts = [];
	completed = [];
	provider = "s3";
	vi.stubGlobal("window", globalThis as typeof globalThis & Window);
	vi.stubGlobal("XMLHttpRequest", RecordingXMLHttpRequest);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (!String(input).endsWith("/presign-part")) completed = body.parts;
			const reply = String(input).endsWith("/presign-part")
				? { presignedUrl: `part-${body.partNumber}`, provider }
				: { success: true };
			return new Response(JSON.stringify(reply), {
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const bytesOf = (name: string) =>
	new Uint8Array(readFileSync(join(fixtures, name)));

async function indexOf(bytes: Uint8Array<ArrayBuffer>, mimeType: string) {
	const indexer = createRecordingIndexer(mimeType);
	if (!indexer) throw new Error("no indexer");
	await indexBlob(indexer, new Blob([bytes]), 0);
	const index = indexer.finish(bytes.byteLength);
	if (!index) throw new Error("no index");
	return index;
}

async function stored() {
	const parts = [...RecordingXMLHttpRequest.parts].sort(
		(a, b) => Number(a.url.slice(5)) - Number(b.url.slice(5)),
	);
	return new Uint8Array(
		await new Blob(parts.map((part) => part.body)).arrayBuffer(),
	);
}

function uploader(
	mimeType: string,
	subpath: string,
	options: { index?: boolean; provider?: "s3" | "googleDrive" } = {},
) {
	return new InstantRecordingUploader({
		videoId: "video-index" as VideoId,
		uploadId: "upload-index",
		provider: options.provider,
		mimeType,
		subpath,
		setUploadStatus: () => undefined,
		sendProgressUpdate: async () => undefined,
		index: options.index ?? true,
	});
}

function stream(
	target: InstantRecordingUploader,
	bytes: Uint8Array<ArrayBuffer>,
	chunks: number[],
) {
	let recorded = 0;
	for (const size of chunks) {
		target.handleChunk(
			new Blob([bytes.subarray(recorded, recorded + size)]),
			recorded + size,
		);
		recorded += size;
	}
	return recorded;
}

const joined = (left: Uint8Array, right: Uint8Array) => {
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left);
	out.set(right, left.byteLength);
	return out;
};

describe("Studio uploads with a seek index", () => {
	it.each(recordings)(
		"stores a streamed $file followed by its index",
		async ({ file, mimeType, subpath, chunks }) => {
			const bytes = bytesOf(file);
			const index = await indexOf(bytes, mimeType);
			const upload = uploader(mimeType, subpath);
			expect(stream(upload, bytes, chunks)).toBe(bytes.byteLength);
			await upload.finalize({ durationSeconds: 7, subpath });
			expect(await stored()).toEqual(joined(bytes, index));
			expect(completed.reduce((sum, part) => sum + part.size, 0)).toBe(
				bytes.byteLength + index.byteLength,
			);
		},
	);

	it.each(recordings)(
		"stores $file uploaded from its local backup followed by its index",
		async ({ file, mimeType, subpath }) => {
			const bytes = bytesOf(file);
			const index = await indexOf(bytes, mimeType);
			const upload = uploader(mimeType, subpath);
			await upload.finalize({
				finalBlob: new Blob([bytes], { type: mimeType }),
				durationSeconds: 7,
				subpath,
			});
			expect(await stored()).toEqual(joined(bytes, index));
			expect(completed.reduce((sum, part) => sum + part.size, 0)).toBe(
				bytes.byteLength + index.byteLength,
			);
		},
	);

	it("appends the index once when the streamed take also hands over its blob", async () => {
		const [{ file, mimeType, subpath, chunks }] = recordings as [
			(typeof recordings)[0],
		];
		const bytes = bytesOf(file);
		const index = await indexOf(bytes, mimeType);
		const upload = uploader(mimeType, subpath);
		stream(upload, bytes, chunks);
		const finalBlob = new Blob([bytes], { type: mimeType });
		await upload.uploadRemaining(finalBlob);
		await upload.finalize({ finalBlob, durationSeconds: 7, subpath });
		expect(await stored()).toEqual(joined(bytes, index));
	});

	it("tells Google Drive the size with the index in it", async () => {
		const [{ file, mimeType, subpath, chunks }] = recordings as [
			(typeof recordings)[0],
		];
		const bytes = bytesOf(file);
		const index = await indexOf(bytes, mimeType);
		provider = "googleDrive";
		const upload = uploader(mimeType, subpath, { provider });
		stream(upload, bytes, chunks);
		await upload.finalize({ durationSeconds: 7, subpath });
		const total = bytes.byteLength + index.byteLength;
		expect(RecordingXMLHttpRequest.parts.at(-1)?.range).toBe(
			`bytes 0-${total - 1}/${total}`,
		);
		expect(await stored()).toEqual(joined(bytes, index));
	});

	it("stores a take it can't index as recorded", async () => {
		const bytes = bytesOf("chrome-av.mp4").subarray(0, 90_000);
		const upload = uploader("video/mp4", "raw-upload.mp4");
		stream(upload, bytes, [1251, 63804, 24945]);
		await upload.finalize({ durationSeconds: 3, subpath: "raw-upload.mp4" });
		expect(await stored()).toEqual(bytes);
		expect(completed.reduce((sum, part) => sum + part.size, 0)).toBe(90_000);
	});

	it("leaves other uploads as recorded", async () => {
		const bytes = bytesOf("chrome-av.mp4");
		const upload = uploader("video/mp4", "raw-upload.mp4", { index: false });
		stream(upload, bytes, [bytes.byteLength]);
		await upload.finalize({ durationSeconds: 7, subpath: "raw-upload.mp4" });
		expect(await stored()).toEqual(bytes);
	});
});
