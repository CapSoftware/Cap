import { env } from "cloudflare:test";
import { Buffer } from "buffer";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const verify = nacl.sign.detached.verify;

function signedRequest(body: string) {
	const timestamp = "1770000000";
	const signature = nacl.sign.detached(
		Buffer.from(timestamp + body),
		keyPair.secretKey,
	);

	return new Request("https://example.com/interactions", {
		method: "POST",
		body,
		headers: {
			"Content-Type": "application/json",
			"X-Signature-Ed25519": Buffer.from(signature).toString("hex"),
			"X-Signature-Timestamp": timestamp,
		},
	});
}

describe("Discord interaction signatures", () => {
	beforeEach(() => {
		vi.spyOn(nacl.sign.detached, "verify").mockImplementation(
			(message, signature) => verify(message, signature, keyPair.publicKey),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		'{"type":1}',
		'{ "type": 1 }\n',
		'{"type":1,"user":{"username":"caf\\u00e9"}}',
	])("acknowledges a ping signed over the exact body %s", async (body) => {
		const response = await worker.fetch(signedRequest(body), env);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it("rejects a changed body even when its parsed JSON is unchanged", async () => {
		const request = new Request(signedRequest('{"type":1}'), {
			body: '{ "type": 1 }',
		});
		const response = await worker.fetch(request, env);

		expect(response.status).toBe(401);
	});

	it("rejects a changed timestamp", async () => {
		const request = signedRequest('{"type":1}');
		request.headers.set("X-Signature-Timestamp", "1770000001");
		const response = await worker.fetch(request, env);

		expect(response.status).toBe(401);
	});

	it.each(["X-Signature-Ed25519", "X-Signature-Timestamp"])(
		"rejects a missing %s header",
		async (header) => {
			const request = signedRequest('{"type":1}');
			request.headers.delete(header);
			const response = await worker.fetch(request, env);

			expect(response.status).toBe(401);
		},
	);

	it.each(["00", "zz".repeat(64), "00".repeat(64)])(
		"rejects an invalid signature %s",
		async (signature) => {
			const request = signedRequest('{"type":1}');
			request.headers.set("X-Signature-Ed25519", signature);
			const response = await worker.fetch(request, env);

			expect(response.status).toBe(401);
		},
	);

	it("checks the signature before parsing untrusted JSON", async () => {
		const request = new Request("https://example.com/interactions", {
			method: "POST",
			body: "not JSON",
		});
		const response = await worker.fetch(request, env);

		expect(response.status).toBe(401);
	});
});
