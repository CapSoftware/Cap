import { Data, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	checkUploadStorage,
	MAX_UPLOAD_PROBE_BYTES,
	UploadProbeBody,
	UploadProbeLimiter,
	UploadProbeTooLarge,
} from "@/lib/upload-health";

class TestStorageError extends Data.TaggedError("TestStorageError")<{
	message: string;
}> {}

describe("upload measurement", () => {
	it("times body transfer separately from cold-start and storage latency", () => {
		let now = 12_000;
		const probe = new UploadProbeBody(() => now);
		now += 4000;
		probe.append(new Uint8Array(1024));
		now += 800;
		probe.append(new Uint8Array(1024));
		now += 30_000;
		expect(probe.result()).toEqual({ bytes: 2048, bodyReadMs: 800 });
	});

	it("reports buffered or empty bodies as inconclusive timing", () => {
		const probe = new UploadProbeBody(() => 10);
		expect(probe.result()).toEqual({ bytes: 0, bodyReadMs: 0 });
		probe.append(new Uint8Array(1024));
		expect(probe.result()).toEqual({ bytes: 1024, bodyReadMs: 0 });
	});

	it("bounds streamed bodies even when Content-Length is absent or false", () => {
		const probe = new UploadProbeBody();
		probe.append(new Uint8Array(MAX_UPLOAD_PROBE_BYTES));
		expect(() => probe.append(new Uint8Array(1))).toThrow(UploadProbeTooLarge);
		expect(probe.result().bytes).toBe(MAX_UPLOAD_PROBE_BYTES);
		expect(probe.sample().byteLength).toBe(1024);
	});

	it("does not retain the upload or an alias of its storage sample", () => {
		const probe = new UploadProbeBody();
		const bytes = new Uint8Array(2048).fill(7);
		probe.append(bytes);
		bytes.fill(0);
		expect(probe.sample()).toEqual(new Uint8Array(1024).fill(7));
	});
});

describe("selected-storage health check", () => {
	const fixture = () => ({
		userId: "owner",
		bytes: new Uint8Array([1, 2, 3]),
		put: vi.fn((): Effect.Effect<void, unknown> => Effect.void),
		remove: vi.fn((): Effect.Effect<void, unknown> => Effect.void),
		onCleanupFailure: vi.fn(),
		uuid: () => "test-id",
	});

	it("writes under the authenticated user's prefix and cleans up", async () => {
		const deps = fixture();
		await Effect.runPromise(checkUploadStorage(deps));
		expect(deps.put).toHaveBeenCalledWith(
			"owner/.cap-upload-health/test-id",
			deps.bytes,
		);
		expect(deps.remove).toHaveBeenCalledWith(
			"owner/.cap-upload-health/test-id",
		);
	});

	it("keeps a successful write healthy when cleanup fails", async () => {
		const deps = fixture();
		deps.remove.mockReturnValue(
			Effect.fail(new TestStorageError({ message: "delete denied" })),
		);
		await expect(
			Effect.runPromise(checkUploadStorage(deps)),
		).resolves.toBeUndefined();
		expect(deps.onCleanupFailure).toHaveBeenCalledOnce();
	});

	it("reports an unavailable storage destination and still attempts cleanup", async () => {
		const deps = fixture();
		deps.put.mockReturnValue(
			Effect.fail(new TestStorageError({ message: "write failed" })),
		);
		await expect(Effect.runPromise(checkUploadStorage(deps))).rejects.toThrow(
			"write failed",
		);
		expect(deps.remove).toHaveBeenCalledOnce();
	});
});

describe("storage effect execution", () => {
	it("executes cleanup after the write effect fails", async () => {
		const events: string[] = [];
		await expect(
			Effect.runPromise(
				checkUploadStorage({
					userId: "owner",
					bytes: new Uint8Array([1]),
					put: () =>
						Effect.sync(() => events.push("write")).pipe(
							Effect.andThen(
								Effect.fail(new TestStorageError({ message: "failed" })),
							),
						),
					remove: () =>
						Effect.sync(() => {
							events.push("delete");
						}),
					onCleanupFailure: () => {},
				}),
			),
		).rejects.toThrow("failed");
		expect(events).toEqual(["write", "delete"]);
	});
});

describe("upload probe rate limit", () => {
	it("allows two samples and a retry, then rejects repeated checks", () => {
		const limiter = new UploadProbeLimiter();
		for (let i = 0; i < 4; i++) expect(limiter.admit("owner", 0)).toBe(true);
		expect(limiter.admit("owner", 59_999)).toBe(false);
		expect(limiter.admit("other", 59_999)).toBe(true);
		expect(limiter.admit("owner", 60_000)).toBe(true);
	});

	it("bounds its per-process state and expires old entries", () => {
		const limiter = new UploadProbeLimiter();
		for (let i = 0; i < 1024; i++)
			expect(limiter.admit(String(i), 0)).toBe(true);
		expect(limiter.admit("extra", 0)).toBe(false);
		expect(limiter.admit("extra", 60_000)).toBe(true);
	});
});
