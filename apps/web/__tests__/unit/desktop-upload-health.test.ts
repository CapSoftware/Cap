import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS,
	MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
	readUploadHealthProbe,
	UploadHealthProbeEmptyError,
	UploadHealthProbeTimeoutError,
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

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function stalledRequest(signal?: AbortSignal, partial = false) {
	const cancel = vi.fn(() => new Promise<void>(() => {}));
	let waiting!: () => void;
	const stalled = new Promise<void>((resolve) => {
		waiting = resolve;
	});
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (partial) {
					partial = false;
					controller.enqueue(new Uint8Array([1, 2, 3]));
				} else {
					waiting();
				}
			},
			cancel,
		},
		{ highWaterMark: 0 },
	);
	const options = { method: "POST", body, signal, duplex: "half" };
	return { request: new Request(url, options), body, cancel, stalled };
}

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

	it.each(["request", "effect"])(
		"cancels a pre-aborted %s signal without reading the body",
		async (source) => {
			const controller = new AbortController();
			controller.abort();
			const { request, body, cancel } = stalledRequest(
				source === "request" ? controller.signal : undefined,
			);
			const signal = source === "effect" ? controller.signal : undefined;

			await expect(
				readUploadHealthProbe(request, { signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
		},
	);

	it.each([false, true])(
		"rejects an aborted stalled body instead of hashing partial bytes (partial=%s)",
		async (partial) => {
			const controller = new AbortController();
			const { request, body, cancel, stalled } = stalledRequest(
				controller.signal,
				partial,
			);
			const result = readUploadHealthProbe(request);
			const rejected = expect(result).rejects.toMatchObject({
				name: "AbortError",
			});
			await stalled;
			controller.abort();

			await rejected;
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
		},
	);

	it("Effect interruption cancels a partially read body without waiting for the source", async () => {
		const { request, body, cancel, stalled } = stalledRequest(undefined, true);
		const fiber = Effect.runFork(
			Effect.tryPromise((signal) => readUploadHealthProbe(request, { signal })),
		);
		await stalled;
		await Effect.runPromise(Fiber.interrupt(fiber));
		await Promise.resolve();

		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it.each([false, true])(
		"times out a stalled body without returning a digest (partial=%s)",
		async (partial) => {
			vi.useFakeTimers();
			const { request, body, cancel, stalled } = stalledRequest(
				undefined,
				partial,
			);
			const rejected = expect(
				readUploadHealthProbe(request),
			).rejects.toBeInstanceOf(UploadHealthProbeTimeoutError);
			await stalled;
			expect(DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS).toBeGreaterThan(8_000);
			await vi.advanceTimersByTimeAsync(DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS);

			await rejected;
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("rejects an oversized body promptly even when cancellation never settles", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new Uint8Array(MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES + 1),
				);
			},
			cancel,
		});
		const options = { method: "POST", body, duplex: "half" };

		await expect(
			readUploadHealthProbe(new Request(url, options)),
		).rejects.toBeInstanceOf(UploadHealthProbeTooLargeError);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	}, 1_000);

	it("removes deadline and both abort listeners after a complete body", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const effect = new AbortController();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				stream.enqueue(new Uint8Array([1]));
				stream.close();
			},
			cancel,
		});
		const options = {
			method: "POST",
			body,
			signal: controller.signal,
			duplex: "half",
		};
		const request = new Request(url, options);
		const removeRequest = vi.spyOn(request.signal, "removeEventListener");
		const removeEffect = vi.spyOn(effect.signal, "removeEventListener");

		await readUploadHealthProbe(request, { signal: effect.signal });

		expect(removeRequest).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(removeEffect).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
		controller.abort();
		effect.abort();
		expect(cancel).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
	});

	it("cancels only once when both abort signals fire", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const effect = new AbortController();
		const { request, body, cancel, stalled } = stalledRequest(
			controller.signal,
			true,
		);
		const rejected = expect(
			readUploadHealthProbe(request, { signal: effect.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		await stalled;
		controller.abort();
		effect.abort();

		await rejected;
		expect(cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(body.locked).toBe(false);
	});
});
