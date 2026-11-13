import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import app from "../../app";

const SECRET = "thumbnail-remote-secret";
const FIXTURE = readFileSync(
	join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4"),
);

function serveFixture(request: Request, body: Buffer): Response {
	const match = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) {
		return new Response(new Uint8Array(body), {
			headers: {
				"Accept-Ranges": "bytes",
				"Content-Length": String(body.length),
				"Content-Type": "video/mp4",
			},
		});
	}
	const start = Number(match[1]);
	if (start >= body.length) {
		return new Response(null, {
			status: 416,
			headers: { "Content-Range": `bytes */${body.length}` },
		});
	}
	const end = match[2]
		? Math.min(Number(match[2]), body.length - 1)
		: body.length - 1;
	return new Response(new Uint8Array(body.subarray(start, end + 1)), {
		status: 206,
		headers: {
			"Accept-Ranges": "bytes",
			"Content-Range": `bytes ${start}-${end}/${body.length}`,
			"Content-Type": "video/mp4",
		},
	});
}

const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousInternalHosts = process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/missing.mp4")
				return new Response("Not Found", { status: 404 });
			if (pathname === "/unavailable.mp4")
				return new Response("Unavailable", { status: 503 });
			// Serves every read but the one-byte size request.
			if (
				pathname === "/size-fails.mp4" &&
				request.headers.get("range") === "bytes=0-0"
			)
				return new Response("Unavailable", { status: 503 });
			if (pathname === "/not-video.mp4")
				return serveFixture(request, Buffer.alloc(4096, 0x78));
			return serveFixture(request, FIXTURE);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	if (previousInternalHosts === undefined)
		delete process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS;
	else process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = previousInternalHosts;
});

afterAll(async () => {
	await server.stop(true);
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
});

function thumbnailRequest(videoUrl: string) {
	return new Request("http://localhost/video/thumbnail", {
		method: "POST",
		headers: {
			"x-media-server-secret": SECRET,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ videoUrl, width: 160, height: 120 }),
	});
}

describe("POST /video/thumbnail with a remote video", () => {
	test("returns a JPEG for a remote video URL", async () => {
		const response = await app.fetch(
			thumbnailRequest(`${origin}/video.mp4?X-Amz-Signature=abc`),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
	}, 30_000);

	test("answers 422 when the host says the video is not there", async () => {
		const response = await app.fetch(thumbnailRequest(`${origin}/missing.mp4`));
		expect(response.status).toBe(422);
		expect((await response.json()).code).toBe("INPUT_NOT_ACCESSIBLE");
	}, 30_000);

	test("keeps a 5xx answer when the host fails for now", async () => {
		const response = await app.fetch(
			thumbnailRequest(`${origin}/unavailable.mp4`),
		);
		expect(response.status).toBe(500);
	}, 30_000);

	test("answers 422 when the remote file is not a video", async () => {
		const response = await app.fetch(
			thumbnailRequest(`${origin}/not-video.mp4`),
		);
		expect(response.status).toBe(422);
		expect((await response.json()).code).toBe("UNREADABLE_INPUT");
	}, 30_000);

	test("answers 422 for an address the server may not fetch", async () => {
		process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS = "";
		const response = await app.fetch(thumbnailRequest(`${origin}/video.mp4`));
		expect(response.status).toBe(422);
		expect((await response.json()).code).toBe("input-policy-violation");
	}, 30_000);

	test("a size request that fails is not taken for an unreadable file", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: {
					"x-media-server-secret": SECRET,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ videoUrl: `${origin}/size-fails.mp4` }),
			}),
		);
		expect(response.status).toBe(500);
		const healthy = await app.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: {
					"x-media-server-secret": SECRET,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ videoUrl: `${origin}/video.mp4` }),
			}),
		);
		expect(healthy.status).toBe(200);
	}, 30_000);
});
