import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
	readUploadHealthProbe,
	UploadHealthProbeEmptyError,
	UploadHealthProbeTooLargeError,
} from "@/app/api/desktop/upload-health/upload-health";

const url = "https://cap.test/api/desktop/upload-health";
const fixture = new Uint8Array(
	readFileSync(
		new URL(
			"../../../desktop/src-tauri/src/upload_health/fixtures/probe.mp4",
			import.meta.url,
		),
	),
);
const fixtureSha256 =
	"2a53c14ff7bd4380890b938b9d238455661b9aca84c169c8e17215235e46ef5d";

describe("desktop upload health probe", () => {
	it("reads the exact desktop recording fixture and returns its pinned digest", async () => {
		const request = new Request(url, { method: "POST", body: fixture });

		await expect(readUploadHealthProbe(request)).resolves.toEqual({
			receivedBytes: 256 * 1024,
			sha256: fixtureSha256,
		});
	});

	it("hashes uneven stream chunks without changing the digest", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			encoder.encode("a"),
			new Uint8Array(),
			encoder.encode("bc"),
		];
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const options = { method: "POST", body, duplex: "half" };

		await expect(
			readUploadHealthProbe(new Request(url, options)),
		).resolves.toEqual({
			receivedBytes: 3,
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
		expect(body.locked).toBe(false);
	});

	it("reports a distinct digest for a same-length corrupted recording", async () => {
		const body = fixture.slice();
		body[128] = (body[128] ?? 0) ^ 1;
		const received = await readUploadHealthProbe(
			new Request(url, { method: "POST", body }),
		);

		expect(received.receivedBytes).toBe(fixture.byteLength);
		expect(received.sha256).not.toBe(fixtureSha256);
		expect(received.sha256).toBe(
			createHash("sha256").update(body).digest("hex"),
		);
	});

	it("reports a truncated recording's actual length and distinct digest", async () => {
		const body = fixture.slice(0, -1);
		const received = await readUploadHealthProbe(
			new Request(url, { method: "POST", body }),
		);

		expect(received.receivedBytes).toBe(fixture.byteLength - 1);
		expect(received.sha256).not.toBe(fixtureSha256);
	});

	it.each([undefined, new Uint8Array()])(
		"rejects an empty body",
		async (body) => {
			const request = new Request(url, { method: "POST", body });

			await expect(readUploadHealthProbe(request)).rejects.toBeInstanceOf(
				UploadHealthProbeEmptyError,
			);
			expect(request.body?.locked ?? false).toBe(false);
		},
	);

	it("allows exactly the configured maximum", async () => {
		const body = new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES);
		const request = new Request(url, { method: "POST", body });

		await expect(readUploadHealthProbe(request)).resolves.toEqual({
			receivedBytes: body.byteLength,
			sha256: createHash("sha256").update(body).digest("hex"),
		});
	});

	it("rejects probes larger than the configured maximum", async () => {
		const request = new Request(url, {
			method: "POST",
			body: new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
		});

		await expect(readUploadHealthProbe(request)).rejects.toBeInstanceOf(
			UploadHealthProbeTooLargeError,
		);
	});

	it("preserves the size error if cancelling the stream also fails", async () => {
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(
						new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
					);
				},
				cancel() {
					throw new Error("connection already closed");
				},
			},
			{ highWaterMark: 0 },
		);
		const options = { method: "POST", body, duplex: "half" };

		await expect(
			readUploadHealthProbe(new Request(url, options)),
		).rejects.toBeInstanceOf(UploadHealthProbeTooLargeError);
		expect(body.locked).toBe(false);
	});
});
