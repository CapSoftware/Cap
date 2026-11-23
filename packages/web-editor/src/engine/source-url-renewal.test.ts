import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	ALL_FORMATS,
	BufferSource,
	EncodedPacketSink,
	Input,
	UrlSource,
} from "mediabunny";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseMediaSources } from "./browser-media-inputs";
import { BrowserEditorSourceCatalog } from "./browser-sources";
import {
	answerSourceUrlRenewal,
	exportSourceRefresher,
	isSourceUrlRenewRequest,
	parentSourceUrlRenewer,
} from "./source-url-renewal";

const recording = new Uint8Array(
	readFileSync(new URL("../../browser-replay/screen.mp4", import.meta.url)),
);
const PIECE = 32 * 1024;
const VIDEO_ID = "recording-1";

/// A store that signs links like S3: each bootstrap issues a new token, and a
/// token is refused (403) once it has served `expireAfter` reads.
type Store = {
	run: number;
	issued: number;
	expireAfter: number;
	refuseNew: boolean;
	failBootstrap: boolean;
	size: number;
	reads: Map<string, number>;
	refused: string[];
	valid: Set<string>;
};

let server: Server;
let origin = "";
let previousLocation: PropertyDescriptor | undefined;
let store: Store;
let runs = 0;

function bootstrap() {
	store.issued++;
	const token = `t${store.issued}`;
	if (!store.refuseNew || store.issued === 1) store.valid.add(token);
	return {
		videoId: VIDEO_ID,
		sources: {
			videoId: VIDEO_ID,
			title: "A long recording",
			captionsEnabled: false,
			signedUrlExpiresAt: Date.now() + 20 * 60 * 1000,
			display: {
				url: `${origin}/media/screen.mp4?run=${store.run}&token=${token}`,
				contentType: "video/mp4",
				fps: 30,
				size: store.size,
			},
		},
	};
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", origin);
		if (url.pathname === `/api/editor/videos/${VIDEO_ID}/bootstrap`) {
			if (store.failBootstrap && store.issued > 0) {
				response.writeHead(500).end();
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(bootstrap()));
			return;
		}
		if (url.searchParams.get("run") !== String(store.run)) {
			response.writeHead(410).end();
			return;
		}
		const token = url.searchParams.get("token") ?? "";
		const served = store.reads.get(token) ?? 0;
		if (!store.valid.has(token) || served >= store.expireAfter) {
			store.refused.push(token);
			response.writeHead(403, { "Content-Type": "application/xml" });
			response.end("<Error><Code>AccessDenied</Code></Error>");
			return;
		}
		store.reads.set(token, served + 1);
		const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
		const start = Number(range?.[1] ?? 0);
		const end = Math.min(
			range?.[2] ? Number(range[2]) : recording.byteLength - 1,
			start + PIECE - 1,
			recording.byteLength - 1,
		);
		response.writeHead(206, {
			"Content-Type": "video/mp4",
			"Content-Range": `bytes ${start}-${end}/${recording.byteLength}`,
			"Content-Length": String(end - start + 1),
		});
		response.end(recording.subarray(start, end + 1));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: new URL(`${origin}/editor/`),
	});
});

afterAll(async () => {
	releaseMediaSources();
	if (previousLocation)
		Object.defineProperty(globalThis, "location", previousLocation);
	else Reflect.deleteProperty(globalThis, "location");
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	runs++;
	store = {
		run: runs,
		issued: 0,
		expireAfter: 3,
		refuseNew: false,
		failBootstrap: false,
		size: recording.byteLength,
		reads: new Map(),
		refused: [],
		valid: new Set(),
	};
});

async function packets(input: Input) {
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error("no video track");
	const out: Uint8Array[] = [];
	for await (const packet of new EncodedPacketSink(track).packets()) {
		out.push(packet.data);
	}
	return out;
}

async function exportReader() {
	const catalog = new BrowserEditorSourceCatalog(VIDEO_ID, { fresh: true });
	const sources = await catalog.snapshot(new AbortController().signal);
	catalog.dispose();
	const refresher = exportSourceRefresher(VIDEO_ID, sources);
	const channel = new MessageChannel();
	const { renewer, answer } = parentSourceUrlRenewer(
		channel.port1,
		sources.expiresAt,
	);
	channel.port1.onmessage = (event) => answer(event.data);
	channel.port2.onmessage = (event) => {
		if (isSourceUrlRenewRequest(event.data))
			answerSourceUrlRenewal(channel.port2, event.data, (original, rejected) =>
				refresher.renew(original, rejected),
			);
	};
	const url = sources.segments[0]?.display?.url as string;
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, renewer.urlSourceOptions(url, 4 * 1024 * 1024)),
	});
	return {
		url,
		input,
		close() {
			input.dispose();
			channel.port1.close();
			channel.port2.close();
		},
	};
}

describe("source link renewal", () => {
	it("keeps reading past each expired link with a renewed one", async () => {
		const expected = await packets(
			new Input({
				formats: ALL_FORMATS,
				source: new BufferSource(recording),
			}),
		);
		const reader = await exportReader();
		try {
			expect(reader.url).toContain("token=t1");
			const read = await packets(reader.input);
			expect(read).toEqual(expected);
		} finally {
			reader.close();
		}
		expect(store.refused).toContain("t1");
		expect(store.reads.get("t1")).toBe(3);
		expect(store.issued).toBeGreaterThan(2);
		expect(store.reads.size).toBe(store.issued);
	});

	it("fails clearly when the renewed link is refused too", async () => {
		store.expireAfter = 0;
		store.refuseNew = true;
		const reader = await exportReader();
		try {
			await expect(packets(reader.input)).rejects.toThrow(
				"Recording could not be read after renewing its link (403)",
			);
		} finally {
			reader.close();
		}
		expect(store.refused).toEqual(["t1", "t2"]);
	});

	it("fails clearly when no renewed link can be had", async () => {
		store.expireAfter = 0;
		store.failBootstrap = true;
		const reader = await exportReader();
		try {
			await expect(packets(reader.input)).rejects.toThrow(
				"Recording link expired and could not be renewed",
			);
		} finally {
			reader.close();
		}
		expect(store.issued).toBe(1);
	});

	it("refuses a renewed link to a recording that changed", async () => {
		store.expireAfter = 0;
		const reader = await exportReader();
		store.size = recording.byteLength + 1;
		try {
			await expect(packets(reader.input)).rejects.toThrow(
				"Recording changed while it was exporting",
			);
		} finally {
			reader.close();
		}
	});
});
