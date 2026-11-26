import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { SERVICES } from "../lib/services";
import { probeUrl, SIGNED_PROBE_URL_SECONDS } from "../lib/signed-url";

const storage = SERVICES.find((service) => service.id === "storage");
const website = SERVICES.find((service) => service.id === "website");
const canary = "https://cdn.example.com/owner/video/transcription.vtt";
const now = Date.UTC(2026, 10, 23, 12, 0, 0);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const env = {
	STATUS_STORAGE_KEY_PAIR_ID: "KTESTKEYPAIR",
	STATUS_STORAGE_PRIVATE_KEY: privateKey
		.export({ type: "pkcs1", format: "pem" })
		.toString(),
};

const fromCloudFrontBase64 = (value: string) =>
	Buffer.from(
		value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
		"base64",
	);

describe("storage probe signing", () => {
	test("signs the storage canary with a short canned policy", () => {
		if (!storage) throw new Error("storage service missing");
		const signed = new URL(probeUrl(storage, canary, now, env));
		expect(`${signed.origin}${signed.pathname}`).toBe(canary);
		const expires = Number(signed.searchParams.get("Expires"));
		expect(expires).toBe(Math.floor(now / 1000) + SIGNED_PROBE_URL_SECONDS);
		expect(signed.searchParams.get("Key-Pair-Id")).toBe("KTESTKEYPAIR");

		const policy = JSON.stringify({
			Statement: [
				{
					Resource: canary,
					Condition: { DateLessThan: { "AWS:EpochTime": expires } },
				},
			],
		});
		const verifier = createVerify("RSA-SHA1");
		verifier.update(policy);
		expect(
			verifier.verify(
				publicKey,
				fromCloudFrontBase64(signed.searchParams.get("Signature") ?? ""),
			),
		).toBe(true);
	});

	test("leaves the URL as configured without a key or for other services", () => {
		if (!storage || !website) throw new Error("services missing");
		expect(probeUrl(storage, canary, now, {})).toBe(canary);
		expect(
			probeUrl(storage, canary, now, { STATUS_STORAGE_KEY_PAIR_ID: "K" }),
		).toBe(canary);
		expect(probeUrl(website, "https://cap.so/", now, env)).toBe(
			"https://cap.so/",
		);
	});
});
