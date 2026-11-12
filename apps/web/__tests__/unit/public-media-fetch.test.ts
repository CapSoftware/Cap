import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
}));

import {
	assertPublicMediaUrl,
	fetchPublicMedia,
	limitStreamBytes,
	PublicMediaFetchError,
	publicMediaUrlProblem,
} from "@/lib/public-media-fetch";
import { isBlockedS3Endpoint } from "@/lib/s3-endpoint-policy";

const resolvesTo =
	(table: Record<string, string[]>) =>
	(url: string): Promise<boolean> =>
		isBlockedS3Endpoint(url, async (hostname) => table[hostname] ?? []);

const publicHosts = resolvesTo({
	"media.example.com": ["93.184.216.34"],
	"cdn.example.com": ["93.184.216.35"],
});

const bodyOf = (text: string) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});

const read = async (stream: ReadableStream<Uint8Array>) =>
	new TextDecoder().decode(await new Response(stream).arrayBuffer());

describe("publicMediaUrlProblem", () => {
	it("accepts plain public http and https URLs", () => {
		expect(publicMediaUrlProblem("https://media.example.com/a.mp3")).toBeNull();
		expect(publicMediaUrlProblem("http://media.example.com/a.mp3")).toBeNull();
		expect(publicMediaUrlProblem("https://93.184.216.34/a.mp3")).toBeNull();
	});

	it.each([
		"file:///etc/passwd",
		"ftp://media.example.com/a.mp3",
		"gopher://media.example.com/",
		"data:audio/mpeg;base64,AAAA",
		"javascript:alert(1)",
		"s3://bucket/key",
	])("rejects the non-http scheme in %s", (url) => {
		expect(publicMediaUrlProblem(url)).toBe("unsupported_scheme");
	});

	it.each(["", "not a url", "//media.example.com/a.mp3", "https://"])(
		"rejects the malformed URL %j",
		(url) => {
			expect(publicMediaUrlProblem(url)).toBe("invalid_url");
		},
	);

	it("rejects URLs longer than the limit", () => {
		expect(
			publicMediaUrlProblem(`https://media.example.com/${"a".repeat(2_100)}`),
		).toBe("invalid_url");
	});

	it("rejects credentials in the URL", () => {
		expect(publicMediaUrlProblem("https://user:pass@media.example.com/a")).toBe(
			"credentials_in_url",
		);
		expect(publicMediaUrlProblem("https://user@media.example.com/a")).toBe(
			"credentials_in_url",
		);
	});

	it.each([
		"https://media.example.com:8443/a.mp3",
		"http://media.example.com:8080/a.mp3",
		"http://media.example.com:22/",
		"http://media.example.com:6379/",
	])("rejects the non-default port in %s", (url) => {
		expect(publicMediaUrlProblem(url)).toBe("unsupported_port");
	});

	it.each([
		"http://localhost/a.mp3",
		"http://LOCALHOST/a.mp3",
		"http://api.localhost/a.mp3",
		"http://printer.local/a.mp3",
		"http://metadata.internal/a.mp3",
		"http://127.0.0.1/a.mp3",
		"http://127.1/a.mp3",
		"http://2130706433/a.mp3",
		"http://0x7f000001/a.mp3",
		"http://0177.0.0.1/a.mp3",
		"http://0.0.0.0/a.mp3",
		"http://10.0.0.5/a.mp3",
		"http://172.16.4.1/a.mp3",
		"http://192.168.1.10/a.mp3",
		"http://100.64.0.1/a.mp3",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/a.mp3",
		"http://[::ffff:127.0.0.1]/a.mp3",
		"http://[::ffff:169.254.169.254]/a.mp3",
		"http://[fd00::1]/a.mp3",
		"http://[fe80::1]/a.mp3",
		"http://[64:ff9b::7f00:1]/a.mp3",
	])("rejects the private or loopback address in %s", (url) => {
		expect(publicMediaUrlProblem(url)).toBe("private_address");
	});
});

describe("assertPublicMediaUrl", () => {
	it("passes a host that resolves to a public address", async () => {
		await expect(
			assertPublicMediaUrl("https://media.example.com/a.mp3", publicHosts),
		).resolves.toBeUndefined();
	});

	it("rejects a host that resolves to a private address", async () => {
		const rebinding = resolvesTo({ "evil.example.com": ["10.0.0.7"] });
		await expect(
			assertPublicMediaUrl("https://evil.example.com/a.mp3", rebinding),
		).rejects.toMatchObject({ problem: "private_address" });
	});

	it("rejects a host with one private address among public ones", async () => {
		const mixed = resolvesTo({
			"mixed.example.com": ["93.184.216.34", "169.254.169.254"],
		});
		await expect(
			assertPublicMediaUrl("https://mixed.example.com/a.mp3", mixed),
		).rejects.toMatchObject({ problem: "private_address" });
	});

	it("rejects a host that does not resolve", async () => {
		await expect(
			assertPublicMediaUrl("https://nowhere.example.com/a.mp3", publicHosts),
		).rejects.toBeInstanceOf(PublicMediaFetchError);
	});
});

describe("fetchPublicMedia", () => {
	it("returns the body and declared length of a public file", async () => {
		const request = vi.fn(
			async () =>
				new Response(bodyOf("audio"), {
					status: 200,
					headers: { "content-length": "5", "content-type": "audio/mpeg" },
				}),
		);
		const result = await fetchPublicMedia("https://media.example.com/a.mp3", {
			maxBytes: 100,
			isBlocked: publicHosts,
			request,
		});
		expect(result.contentLength).toBe(5);
		expect(result.finalUrl).toBe("https://media.example.com/a.mp3");
		expect(await read(result.response.body as ReadableStream<Uint8Array>)).toBe(
			"audio",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("never requests a blocked URL", async () => {
		const request = vi.fn();
		await expect(
			fetchPublicMedia("http://169.254.169.254/latest/meta-data/", {
				maxBytes: 100,
				isBlocked: publicHosts,
				request,
			}),
		).rejects.toMatchObject({ problem: "private_address" });
		expect(request).not.toHaveBeenCalled();
	});

	it("follows a redirect between public hosts", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://cdn.example.com/b.mp3" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(bodyOf("ok"), {
					status: 200,
					headers: { "content-length": "2" },
				}),
			);
		const result = await fetchPublicMedia("https://media.example.com/a.mp3", {
			maxBytes: 100,
			isBlocked: publicHosts,
			request,
		});
		expect(result.finalUrl).toBe("https://cdn.example.com/b.mp3");
		expect(request.mock.calls.map(([url]) => url)).toEqual([
			"https://media.example.com/a.mp3",
			"https://cdn.example.com/b.mp3",
		]);
	});

	it.each([
		"http://127.0.0.1/admin",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:3000/",
		"file:///etc/passwd",
		"https://media.example.com:8443/a.mp3",
		"https://user:pass@media.example.com/a.mp3",
	])("refuses a redirect to %s without requesting it", async (location) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location } }),
			);
		await expect(
			fetchPublicMedia("https://media.example.com/a.mp3", {
				maxBytes: 100,
				isBlocked: publicHosts,
				request,
			}),
		).rejects.toBeInstanceOf(PublicMediaFetchError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("refuses a redirect to a host that resolves privately", async () => {
		const isBlocked = resolvesTo({
			"media.example.com": ["93.184.216.34"],
			"internal.example.com": ["10.1.2.3"],
		});
		const request = vi.fn().mockResolvedValueOnce(
			new Response(null, {
				status: 307,
				headers: { location: "https://internal.example.com/secret" },
			}),
		);
		await expect(
			fetchPublicMedia("https://media.example.com/a.mp3", {
				maxBytes: 100,
				isBlocked,
				request,
			}),
		).rejects.toMatchObject({ problem: "private_address" });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("stops after too many redirects", async () => {
		const request = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://media.example.com/loop" },
				}),
		);
		await expect(
			fetchPublicMedia("https://media.example.com/a.mp3", {
				maxBytes: 100,
				isBlocked: publicHosts,
				request,
				maxRedirects: 3,
			}),
		).rejects.toMatchObject({ problem: "too_many_redirects" });
		expect(request).toHaveBeenCalledTimes(4);
	});

	it.each([204, 206, 304, 401, 404, 500])(
		"rejects the status %i",
		async (status) => {
			const request = vi.fn(async () => new Response(null, { status }));
			await expect(
				fetchPublicMedia("https://media.example.com/a.mp3", {
					maxBytes: 100,
					isBlocked: publicHosts,
					request,
				}),
			).rejects.toMatchObject({ problem: "bad_status" });
		},
	);

	it("rejects a file whose declared size is over the limit", async () => {
		const request = vi.fn(
			async () =>
				new Response(bodyOf("x"), {
					status: 200,
					headers: { "content-length": "101" },
				}),
		);
		await expect(
			fetchPublicMedia("https://media.example.com/a.mp3", {
				maxBytes: 100,
				isBlocked: publicHosts,
				request,
			}),
		).rejects.toMatchObject({ problem: "too_large" });
	});

	it("reports a missing content length as unknown", async () => {
		const request = vi.fn(
			async () => new Response(bodyOf("stream"), { status: 200 }),
		);
		const result = await fetchPublicMedia("https://media.example.com/a.mp3", {
			maxBytes: 100,
			isBlocked: publicHosts,
			request,
		});
		expect(result.contentLength).toBeNull();
	});
});

describe("limitStreamBytes", () => {
	it("passes a stream within the limit", async () => {
		expect(await read(limitStreamBytes(bodyOf("12345"), 5))).toBe("12345");
	});

	it("fails a stream that goes over the limit", async () => {
		await expect(read(limitStreamBytes(bodyOf("123456"), 5))).rejects.toThrow(
			/larger than the limit/,
		);
	});
});
