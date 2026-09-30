import { describe, expect, test } from "bun:test";
import { getSourceSize } from "../../lib/media-common";

describe("remote media size", () => {
	for (const sample of [
		{
			status: 206,
			headers: { "Content-Range": "bytes 0-0/1024", "Content-Length": "1" },
			size: 1024,
		},
		{ status: 200, headers: { "Content-Length": "1024" }, size: 1024 },
		{ status: 403, headers: { "Content-Length": "1024" }, size: null },
		{ status: 206, headers: { "Content-Length": "1" }, size: null },
		{ status: 206, headers: { "Content-Range": "bytes 1-1/1024" }, size: null },
		{
			status: 206,
			headers: { "Content-Range": "bytes 0-0/9007199254740992" },
			size: null,
		},
		{ status: 200, headers: {}, size: null },
	]) {
		test(`validates size response ${JSON.stringify(sample)}`, async () => {
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					expect(request.method).toBe("GET");
					expect(request.headers.get("range")).toBe("bytes=0-0");
					return new Response(
						sample.size === 1024 && sample.status === 200
							? new Uint8Array(1024)
							: null,
						{
							status: sample.status,
							headers: sample.headers,
						},
					);
				},
			});
			try {
				const result = getSourceSize(
					`${server.url}video.mp4`.replace("http:", "HTTP:"),
				);
				if (sample.size === null) {
					await expect(result).rejects.toThrow(
						"Media input size is unavailable",
					);
				} else {
					expect(await result).toBe(sample.size);
				}
			} finally {
				await server.stop(true);
			}
		});
	}
});
