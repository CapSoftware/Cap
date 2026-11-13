// Times one upload through the package's MultipartClient.
//
//   bun packages/sdk-recorder/scripts/upload-bench.ts \
//     --api https://your-cap-host --token cut_... --file ./video.mp4
//
// --client <path> loads another copy of multipart-client.ts (for example the
// one from main) so two clients can be timed on the same link.
// --fake starts a local API and storage stand-in instead of --api and --token;
// --fake-flow-mbps limits each connection and --fake-rtt-ms delays each request.

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		api: { type: "string" },
		token: { type: "string" },
		file: { type: "string" },
		client: { type: "string" },
		fake: { type: "boolean", default: false },
		"fake-flow-mbps": { type: "string", default: "20" },
		"fake-rtt-ms": { type: "string", default: "120" },
		"duration-ms": { type: "string" },
	},
});

if (!values.file) {
	console.error("--file is required");
	process.exit(2);
}

const clientPath = values.client
	? new URL(values.client, `file://${process.cwd()}/`).href
	: new URL("../src/upload/multipart-client.ts", import.meta.url).href;
const { MultipartClient } = (await import(clientPath)) as {
	MultipartClient: new (
		apiBase: string,
		token: string,
	) => {
		uploadBlob(
			videoId: string,
			blob: Blob,
			options?: {
				durationMs?: number;
				onProgress?: (progress: number) => void;
			},
		): Promise<void>;
	};
};

function startFakeServer(flowMbps: number, rttMs: number) {
	const parts = new Map<number, number>();
	const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			await delay(rttMs);
			if (url.pathname.startsWith("/part/")) {
				const bytes = (await request.arrayBuffer()).byteLength;
				await delay(((bytes * 8) / (flowMbps * 1e6)) * 1000);
				const partNumber = Number(url.pathname.split("/").at(-1));
				parts.set(partNumber, bytes);
				return new Response(null, { headers: { ETag: `"p${partNumber}"` } });
			}
			const body = (await request.json().catch(() => ({}))) as {
				partNumbers?: number[];
				parts?: { partNumber: number; size: number }[];
			};
			if (url.pathname.endsWith("/initiate"))
				return Response.json({ uploadId: "fake-upload" });
			if (url.pathname.endsWith("/presign-part"))
				return Response.json({
					parts: (body.partNumbers ?? []).map((partNumber) => ({
						partNumber,
						presignedUrl: `${url.origin}/part/${partNumber}`,
					})),
				});
			if (url.pathname.endsWith("/complete")) {
				const listed = body.parts ?? [];
				const ordered = listed.every(
					(part, index) => part.partNumber === index + 1,
				);
				const matched = listed.every(
					(part) => parts.get(part.partNumber) === part.size,
				);
				if (!ordered || !matched)
					return new Response("parts do not match", { status: 400 });
				return Response.json({ success: true });
			}
			if (url.pathname.endsWith("/abort"))
				return Response.json({ success: true });
			return new Response("not found", { status: 404 });
		},
	});
	return server;
}

const fake = values.fake
	? startFakeServer(
			Number(values["fake-flow-mbps"]),
			Number(values["fake-rtt-ms"]),
		)
	: null;
const apiBase = fake ? `http://127.0.0.1:${fake.port}` : values.api;
const token = fake ? "cut_fake" : values.token;
if (!apiBase || !token) {
	console.error("--api and --token are required unless --fake is set");
	process.exit(2);
}

const videoId = fake
	? "fake-video"
	: (
			JSON.parse(
				Buffer.from(
					token.slice("cut_".length).split(".")[0] ?? "",
					"base64url",
				).toString("utf8"),
			) as { video: string }
		).video;

const realFetch = globalThis.fetch;
const puts: { ms: number; bytes: number }[] = [];
let inFlight = 0;
let maxInFlight = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method !== "PUT") return realFetch(input, init);
	const started = performance.now();
	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	try {
		return await realFetch(input, init);
	} finally {
		inFlight--;
		puts.push({
			ms: performance.now() - started,
			bytes: (init.body as Blob | undefined)?.size ?? 0,
		});
	}
}) as typeof fetch;

const file = Bun.file(values.file);
const blob = new Blob([await file.arrayBuffer()], {
	type: file.type || "video/mp4",
});
const started = performance.now();
let lastLogged = -1;
await new MultipartClient(apiBase, token).uploadBlob(videoId, blob, {
	durationMs: values["duration-ms"] ? Number(values["duration-ms"]) : undefined,
	onProgress: (progress) => {
		const percent = Math.floor(progress * 10) * 10;
		if (percent !== lastLogged) {
			lastLogged = percent;
			console.error(
				`${percent}% after ${((performance.now() - started) / 1000).toFixed(1)} s`,
			);
		}
	},
});
const seconds = (performance.now() - started) / 1000;
const sorted = puts.map((put) => put.ms).sort((a, b) => a - b);
const percentile = (p: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

console.log(
	JSON.stringify(
		{
			client: values.client ?? "package",
			videoId,
			bytes: blob.size,
			seconds: Number(seconds.toFixed(2)),
			mbps: Number(((blob.size * 8) / seconds / 1e6).toFixed(2)),
			parts: puts.length,
			partBytes: puts[0]?.bytes ?? 0,
			maxInFlight,
			putMs: {
				p50: Math.round(percentile(0.5)),
				p90: Math.round(percentile(0.9)),
				max: Math.round(sorted.at(-1) ?? 0),
			},
		},
		null,
		2,
	),
);
fake?.stop(true);
