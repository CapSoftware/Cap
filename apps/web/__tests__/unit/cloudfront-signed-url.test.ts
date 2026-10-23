import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	createCloudFrontSignedUrl,
	getCloudFrontObjectUrl,
} from "../../../../packages/web-backend/src/S3Buckets/cloudfront-signed-url";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const bucketUrl = "https://cdn.example.com";

const sign = (key: string) =>
	createCloudFrontSignedUrl({
		bucketUrl,
		key,
		keyPairId: "K2JCJMDEHXQW5F",
		privateKey,
		expiresAt: 1_900_000_000,
	});

const decodePolicy = (signedUrl: string) => {
	const encoded = new URL(signedUrl).searchParams.get("Policy") ?? "";
	const base64 = encoded
		.replace(/-/g, "+")
		.replace(/_/g, "=")
		.replace(/~/g, "/");
	return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
		Statement: { Resource: string }[];
	};
};

const resourceOf = (signedUrl: string) =>
	decodePolicy(signedUrl).Statement[0]?.Resource;

const baseOf = (signedUrl: string) =>
	signedUrl.slice(0, signedUrl.indexOf("?"));

describe("createCloudFrontSignedUrl", () => {
	it("signs ordinary keys for the exact object URL", () => {
		const signedUrl = sign("user/video/result.mp4");

		expect(resourceOf(signedUrl)).toBe(
			"https://cdn.example.com/user/video/result.mp4",
		);
		expect(baseOf(signedUrl)).toBe(resourceOf(signedUrl));
	});

	it("does not leave CloudFront wildcards in the policy resource", () => {
		for (const key of [
			"user/video/*",
			"user/video/?",
			"user/video/*.mp4",
			"user/video/a?b/*",
		]) {
			const signedUrl = sign(key);
			const resource = resourceOf(signedUrl) ?? "";

			expect(resource).not.toMatch(/[*?]/);
			expect(baseOf(signedUrl)).toBe(resource);
		}
	});

	it("percent-encodes wildcard and reserved characters per path segment", () => {
		expect(getCloudFrontObjectUrl(bucketUrl, "user/video/a*b?c d#e%f")).toBe(
			"https://cdn.example.com/user/video/a%2Ab%3Fc%20d%23e%25f",
		);
		expect(getCloudFrontObjectUrl(bucketUrl, "user/video/(1)!'.mp4")).toBe(
			"https://cdn.example.com/user/video/%281%29%21%27.mp4",
		);
	});

	it("keeps the returned URL aligned with the signed resource for encoded keys", () => {
		const signedUrl = sign("user/video/my clip (1).mp4");

		expect(resourceOf(signedUrl)).toBe(
			"https://cdn.example.com/user/video/my%20clip%20%281%29.mp4",
		);
		expect(baseOf(signedUrl)).toBe(resourceOf(signedUrl));
	});
});
