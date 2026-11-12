import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	cloudFrontExpiresAt,
	createCloudFrontSignedUrl,
	getCloudFrontObjectUrl,
} from "../../../../packages/web-backend/src/S3Buckets/cloudfront-signed-url";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const bucketUrl = "https://cdn.example.com";

const sign = (key: string, expiresAt = 1_900_000_000) =>
	createCloudFrontSignedUrl({
		bucketUrl,
		key,
		keyPairId: "K2JCJMDEHXQW5F",
		privateKey,
		expiresAt,
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

	it("gives the same URL for the same key and expiry, and another for a later expiry", () => {
		const signedUrl = sign("user/video/result.mp4");

		expect(sign("user/video/result.mp4")).toBe(signedUrl);
		expect(sign("user/video/result.mp4", 1_900_000_001)).not.toBe(signedUrl);
		expect(sign("user/video/other.mp4")).not.toBe(signedUrl);
	});
});

describe("cloudFrontExpiresAt", () => {
	const now = 1_794_500_000_999;

	it("counts from now when no signing date is given", () => {
		expect(cloudFrontExpiresAt(undefined, now)).toBe(1_794_503_600);
		expect(cloudFrontExpiresAt({}, now)).toBe(1_794_503_600);
		expect(cloudFrontExpiresAt({ expiresIn: 43_200 }, now)).toBe(
			Math.floor((now + 43_200 * 1000) / 1000),
		);
	});

	it("counts from the signing date when one is given", () => {
		const signingDate = new Date("2026-11-12T12:00:00.000Z");
		const expected = signingDate.getTime() / 1000 + 600;

		expect(cloudFrontExpiresAt({ signingDate, expiresIn: 600 }, now)).toBe(
			expected,
		);
		expect(
			cloudFrontExpiresAt(
				{ signingDate: signingDate.toISOString(), expiresIn: 600 },
				now,
			),
		).toBe(expected);
		expect(
			cloudFrontExpiresAt(
				{ signingDate: signingDate.getTime() / 1000, expiresIn: 600 },
				now,
			),
		).toBe(expected);
		expect(
			cloudFrontExpiresAt(
				{ signingDate: String(signingDate.getTime() / 1000), expiresIn: 600 },
				now,
			),
		).toBe(expected);
	});

	it("counts from now when the signing date cannot be read", () => {
		expect(
			cloudFrontExpiresAt({ signingDate: "not a date", expiresIn: 600 }, now),
		).toBe(Math.floor((now + 600_000) / 1000));
		expect(
			cloudFrontExpiresAt(
				{ signingDate: new Date(Number.NaN), expiresIn: 600 },
				now,
			),
		).toBe(Math.floor((now + 600_000) / 1000));
	});
});
