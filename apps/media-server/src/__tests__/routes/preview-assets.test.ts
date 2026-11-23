import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import app from "../../app";

const SECRET = "preview-assets-secret";
const FIXTURE = readFileSync(
	join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4"),
);

type Upload = { path: string; contentType: string | null; bytes: Uint8Array };

const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const uploads: Upload[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin = "";

function serveFixture(request: Request) {
	const match = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
	if (!match) {
		return new Response(new Uint8Array(FIXTURE), {
			headers: {
				"Accept-Ranges": "bytes",
				"Content-Length": String(FIXTURE.length),
				"Content-Type": "video/mp4",
			},
		});
	}
	const start = Number(match[1]);
	const end = match[2]
		? Math.min(Number(match[2]), FIXTURE.length - 1)
		: FIXTURE.length - 1;
	return new Response(new Uint8Array(FIXTURE.subarray(start, end + 1)), {
		status: 206,
		headers: {
			"Accept-Ranges": "bytes",
			"Content-Range": `bytes ${start}-${end}/${FIXTURE.length}`,
			"Content-Type": "video/mp4",
		},
	});
}

beforeAll(() => {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method === "PUT") {
				uploads.push({
					path: pathname,
					contentType: request.headers.get("content-type"),
					bytes: new Uint8Array(await request.arrayBuffer()),
				});
				return new Response(null, { status: 200, headers: { ETag: '"1"' } });
			}
			if (pathname === "/not-video.mp4")
				return new Response(new Uint8Array(4096).fill(0x78), {
					headers: { "Content-Type": "video/mp4" },
				});
			return serveFixture(request);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.stop(true);
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
});

function previewAssetsRequest(body: unknown, secret: string | null = SECRET) {
	return new Request("http://localhost/video/preview-assets", {
		method: "POST",
		headers: {
			...(secret ? { "x-media-server-secret": secret } : {}),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("POST /video/preview-assets", () => {
	test("refuses a request without the media server secret", async () => {
		const response = await app.fetch(
			previewAssetsRequest(
				{
					videoUrl: `${origin}/video.mp4`,
					previewGifPresignedUrl: `${origin}/put/preview.gif`,
				},
				null,
			),
		);
		expect(response.status).toBe(401);
	});

	test("refuses a request that asks for no asset", async () => {
		const response = await app.fetch(
			previewAssetsRequest({ videoUrl: `${origin}/video.mp4` }),
		);
		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("INVALID_REQUEST");
	});

	test("makes the thumbnail and preview GIF and uploads both", async () => {
		uploads.length = 0;
		const response = await app.fetch(
			previewAssetsRequest({
				videoUrl: `${origin}/video.mp4`,
				thumbnailPresignedUrl: `${origin}/put/screenshot.jpg`,
				previewGifPresignedUrl: `${origin}/put/preview.gif`,
			}),
		);
		expect(response.status).toBe(200);
		expect(uploads.map((upload) => [upload.path, upload.contentType])).toEqual([
			["/put/screenshot.jpg", "image/jpeg"],
			["/put/preview.gif", "image/gif"],
		]);
		const [thumbnail, gif] = uploads;
		expect([thumbnail?.bytes[0], thumbnail?.bytes[1]]).toEqual([0xff, 0xd8]);
		expect(new TextDecoder().decode(gif?.bytes.subarray(0, 4))).toBe("GIF8");
	});

	test("answers 422 for a file that is not a video", async () => {
		const response = await app.fetch(
			previewAssetsRequest({
				videoUrl: `${origin}/not-video.mp4`,
				previewGifPresignedUrl: `${origin}/put/preview.gif`,
			}),
		);
		expect(response.status).toBe(422);
	});
});
