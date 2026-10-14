import { describe, expect, test } from "bun:test";
import {
	assertUrlAllowed,
	collectUrls,
	getUrlPolicy,
	isPrivateAddress,
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
