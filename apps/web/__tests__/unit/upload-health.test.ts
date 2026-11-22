import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	checkUploadStorage,
	MAX_UPLOAD_PROBE_BYTES,
	UploadProbeBody,
	UploadProbeLimiter,
	UploadProbeTooLarge,
} from "@/lib/upload-health";

describe("upload health probe timing", () => {
	it("measures body transfer time without cold-start or storage latency", () => {
		const times = [1_000, 1_125, 1_500];
		const probe = new UploadProbeBody(() => times.shift() ?? 1_500);

		probe.append(new Uint8Array(512 * 1024));
		probe.append(new Uint8Array(512 * 1024));
		probe.append(new Uint8Array(1024 * 1024));

		expect(probe.result()).toEqual({
			bytes: 2 * 1024 * 1024,
			bodyReadMs: 500,
		});
	});

	it("reports zero read duration for single-chunk or empty bodies", () => {
		const singleChunk = new UploadProbeBody(() => 42);
		singleChunk.append(new Uint8Array(1024));
		expect(singleChunk.result()).toEqual({ bytes: 1024, bodyReadMs: 0 });

		const empty = new UploadProbeBody(() => 42);
		empty.append(new Uint8Array());
		expect(empty.result()).toEqual({ bytes: 0, bodyReadMs: 0 });
	});

	it("rejects streamed bodies larger than 8 MiB without buffering the full payload", () => {
		const probe = new UploadProbeBody(() => 0);
		probe.append(new Uint8Array(MAX_UPLOAD_PROBE_BYTES));

		expect(() => probe.append(new Uint8Array(1))).toThrow(UploadProbeTooLarge);
		expect(probe.sample().byteLength).toBe(1024);
	});
});

describe("upload storage health check", () => {
	it("writes under the user prefix and always cleans up the probe object", async () => {
		const events: string[] = [];
		const sample = new Uint8Array([1, 2, 3, 4]);

		await Effect.runPromise(
			checkUploadStorage({
				userId: "user-123",
				bytes: sample,
				uuid: () => "probe-1",
				put: (key, body) =>
					Effect.sync(() => {
						events.push(`put:${key}:${body.byteLength}`);
					}),
				remove: (key) =>
					Effect.sync(() => {
						events.push(`delete:${key}`);
					}),
			}),
		);

		expect(events).toEqual([
			"put:user-123/.cap-upload-health/probe-1:4",
			"delete:user-123/.cap-upload-health/probe-1",
		]);
	});

	it("does not fail a successful storage write when cleanup fails", async () => {
		const onCleanupFailure = vi.fn();

		await expect(
			Effect.runPromise(
				checkUploadStorage({
					userId: "user-123",
					bytes: new Uint8Array([1]),
					uuid: () => "probe-1",
					put: () => Effect.void,
					remove: () => Effect.fail(new Error("delete denied")),
					onCleanupFailure,
				}),
			),
		).resolves.toBeUndefined();

		expect(onCleanupFailure).toHaveBeenCalledOnce();
	});

	it("Still attempts cleanup if the storage write fails", async () => {
		const remove = vi.fn(() => Effect.void);

		await expect(
			Effect.runPromise(
				checkUploadStorage({
					userId: "user-123",
					bytes: new Uint8Array([1]),
					uuid: () => "probe-1",
					put: () => Effect.fail(new Error("put denied")),
					remove,
				}),
			),
		).rejects.toThrow("put denied");

		expect(remove).toHaveBeenCalledWith("user-123/.cap-upload-health/probe-1");
	});
});

describe("upload probe rate limiter", () => {
	it("allows two two-sample checks per minute per user and resets after the window", () => {
		let now = 0;
		const limiter = new UploadProbeLimiter({
			limit: 4,
			windowMs: 60_000,
			now: () => now,
		});

		expect(limiter.admit("user-1")).toBe(true);
		expect(limiter.admit("user-1")).toBe(true);
		expect(limiter.admit("user-1")).toBe(true);
		expect(limiter.admit("user-1")).toBe(true);
		expect(limiter.admit("user-1")).toBe(false);
		expect(limiter.admit("user-2")).toBe(true);

		now = 60_000;
		expect(limiter.admit("user-1")).toBe(true);
	});

	it("bounds in-memory limiter state across many users", () => {
		const limiter = new UploadProbeLimiter({
			limit: 4,
			windowMs: 60_000,
			maxEntries: 2,
			now: () => 0,
		});

		expect(limiter.admit("user-1")).toBe(true);
		expect(limiter.admit("user-2")).toBe(true);
		expect(limiter.admit("user-3")).toBe(true);
		expect(limiter.admit("user-1")).toBe(true);
	});
});
