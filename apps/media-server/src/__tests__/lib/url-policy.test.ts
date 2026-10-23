import { describe, expect, test } from "bun:test";
import {
	assertUrlAllowed,
	collectUrls,
	fetchAllowed,
	getUrlPolicy,
	isPrivateAddress,
	resolveAllowedUrl,
} from "../../lib/url-policy";

const resolveTo =
	(...addresses: string[]) =>
	async () =>
		addresses;

describe("isPrivateAddress", () => {
	test("flags loopback, private, link-local, CGNAT and ULA addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.5",
			"192.168.1.10",
			"169.254.169.254",
			"100.100.1.1",
			"::1",
			"fd12:3456::1",
			"fe80::1",
			"::ffff:127.0.0.1",
		]) {
			expect(isPrivateAddress(address)).toBe(true);
		}
	});

	test("allows public addresses", () => {
		expect(isPrivateAddress("93.184.216.34")).toBe(false);
		expect(isPrivateAddress("2606:4700::6810:85e5")).toBe(false);
	});
});

describe("assertUrlAllowed", () => {
	const open = getUrlPolicy({});

	test("blocks cloud metadata and private hosts by default", async () => {
		await expect(
			assertUrlAllowed("http://169.254.169.254/latest/meta-data/", open),
		).rejects.toThrow("private address");
		await expect(
			assertUrlAllowed(
				"http://internal.example/x",
				open,
				resolveTo("10.0.0.7"),
			),
		).rejects.toThrow("private address");
	});

	test("blocks non-http schemes", async () => {
		await expect(assertUrlAllowed("file:///etc/passwd", open)).rejects.toThrow(
			"scheme",
		);
	});

	test("allows public hosts when no allow-list is configured", async () => {
		await expect(
			assertUrlAllowed(
				"https://bucket.s3.amazonaws.com/v.mp4",
				open,
				resolveTo("52.216.1.1"),
			),
		).resolves.toBeUndefined();
	});

	test("allows the configured S3 endpoint on a private network", async () => {
		const policy = getUrlPolicy({ S3_INTERNAL_ENDPOINT: "http://minio:9000" });
		await expect(
			assertUrlAllowed(
				"http://minio:9000/cap/v.mp4",
				policy,
				resolveTo("172.18.0.3"),
			),
		).resolves.toBeUndefined();
	});

	test("does not treat a trusted host as allowed on every port", async () => {
		const policy = getUrlPolicy({
			S3_PUBLIC_ENDPOINT: "http://localhost:9000",
			MEDIA_SERVER_WEBHOOK_URL: "http://cap-web:3000",
		});
		await expect(
			assertUrlAllowed(
				"http://minio:445/cap/v.mp4",
				policy,
				resolveTo("10.0.0.2"),
			),
		).rejects.toThrow("private address");
		await expect(
			assertUrlAllowed(
				"http://localhost:6379/",
				policy,
				resolveTo("127.0.0.1"),
			),
		).rejects.toThrow("private address");
		await expect(
			assertUrlAllowed("http://localhost:9000/bucket/v.mp4", policy),
		).resolves.toBeUndefined();
	});

	test("blocks file URLs even when private URLs are allowed", async () => {
		const policy = getUrlPolicy({ MEDIA_SERVER_ALLOW_PRIVATE_URLS: "true" });
		await expect(
			assertUrlAllowed("file:///etc/passwd", policy),
		).rejects.toThrow("scheme");
	});

	test("enforces MEDIA_SERVER_ALLOWED_HOSTS when set", async () => {
		const policy = getUrlPolicy({
			MEDIA_SERVER_ALLOWED_HOSTS: "*.r2.cloudflarestorage.com",
			MEDIA_SERVER_WEBHOOK_URL: "http://cap-web:3000",
		});
		await expect(
			assertUrlAllowed(
				"https://acct.r2.cloudflarestorage.com/v.mp4",
				policy,
				resolveTo("104.18.1.1"),
			),
		).resolves.toBeUndefined();
		await expect(
			assertUrlAllowed("http://cap-web:3000/api/webhooks", policy),
		).resolves.toBeUndefined();
		await expect(
			assertUrlAllowed(
				"https://evil.example/v.mp4",
				policy,
				resolveTo("1.1.1.1"),
			),
		).rejects.toThrow("MEDIA_SERVER_ALLOWED_HOSTS");
	});
});

describe("redirect checks", () => {
	test("does not follow a redirect to a private address", async () => {
		const policy = getUrlPolicy({});
		const fetcher = async (input: string) => {
			if (input === "https://93.184.216.34/v.mp4") {
				return new Response(null, {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data/" },
				});
			}
			return new Response("ok");
		};
		await expect(
			fetchAllowed(
				"https://cdn.example/v.mp4",
				{},
				policy,
				resolveTo("93.184.216.34"),
				fetcher,
			),
		).rejects.toThrow("private address");
		await expect(
			resolveAllowedUrl(
				"https://cdn.example/v.mp4",
				policy,
				resolveTo("93.184.216.34"),
				fetcher,
			),
		).rejects.toThrow("private address");
	});
});

describe("collectUrls", () => {
	test("collects nested url fields only", () => {
		expect(
			collectUrls({
				videoUrl: "http://a/1",
				name: "http://not-a-url-field",
				segments: [{ url: "http://b/2" }],
				videoSegmentUrls: ["http://c/3"],
			}),
		).toEqual(["http://a/1", "http://b/2", "http://c/3"]);
	});
});

describe("connection address pinning", () => {
	test.each(["fetch", "resolve"])(
		"pins the checked address during %s without another hostname lookup",
		async (mode) => {
			let lookups = 0;
			const resolve = async () =>
				++lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
			let connections = 0;
			const fetcher: NonNullable<Parameters<typeof fetchAllowed>[4]> = async (
				input,
				init,
			) => {
				connections++;
				expect(input).toBe("https://93.184.216.34:8443/video.mp4?token=signed");
				expect(new Headers(init?.headers).get("host")).toBe("cdn.example:8443");
				expect(init?.tls?.serverName).toBe("cdn.example");
				expect(init?.proxy).toBe(false);
				return new Response("ok");
			};
			const url = "https://cdn.example:8443/video.mp4?token=signed";
			if (mode === "fetch") {
				const response = await fetchAllowed(
					url,
					{},
					getUrlPolicy({}),
					resolve,
					fetcher,
				);
				expect(response.url).toBe(url);
			} else {
				expect(
					await resolveAllowedUrl(url, getUrlPolicy({}), resolve, fetcher),
				).toBe(url);
			}
			expect(lookups).toBe(1);
			expect(connections).toBe(1);
		},
	);

	test("resolves relative redirects against the original hostname", async () => {
		const seen: string[] = [];
		const fetcher: NonNullable<Parameters<typeof fetchAllowed>[4]> = async (
			input,
			init,
		) => {
			seen.push(input);
			expect(new Headers(init?.headers).get("host")).toBe("cdn.example");
			return seen.length === 1
				? new Response(null, {
						status: 302,
						headers: { location: "../video.mp4" },
					})
				: new Response("ok");
		};
		await fetchAllowed(
			"https://cdn.example/start/redirect",
			{},
			getUrlPolicy({}),
			resolveTo("93.184.216.34"),
			fetcher,
		);
		expect(seen).toEqual([
			"https://93.184.216.34/start/redirect",
			"https://93.184.216.34/video.mp4",
		]);
	});

	test("refuses callback redirects before sending a secret to the target", async () => {
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return new Response(null, {
				status: 307,
				headers: { location: "https://other.example/secret" },
			});
		};
		await expect(
			fetchAllowed(
				"https://cdn.example/callback",
				{
					method: "POST",
					redirect: "error",
					headers: { "x-media-server-secret": "test-secret" },
					body: "recording-details",
				},
				getUrlPolicy({}),
				resolveTo("93.184.216.34"),
				fetcher,
			),
		).rejects.toThrow("Redirects are not allowed");
		expect(calls).toBe(1);
	});

	test("returns manual redirects without following them", async () => {
		let calls = 0;
		const response = await fetchAllowed(
			"https://cdn.example/callback",
			{ redirect: "manual" },
			getUrlPolicy({}),
			resolveTo("93.184.216.34"),
			async () => {
				calls++;
				return new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/" },
				});
			},
		);
		expect(response.status).toBe(302);
		expect(calls).toBe(1);
	});
});
