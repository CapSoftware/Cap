import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	checkUploadProbeRateLimit,
	countRequestBodyBytes,
	MAX_UPLOAD_PROBE_BYTES,
	readUploadProbeBody,
	resetUploadProbeRateLimitForTests,
	UPLOAD_PROBE_RATE_LIMIT_MAX_REQUESTS,
} from "@/lib/upload-health";

function streamOf(chunks: number[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const size of chunks) {
				controller.enqueue(new Uint8Array(size));
			}
			controller.close();
		},
	});
}

describe("countRequestBodyBytes", () => {
	it("returns zero for a missing body", async () => {
		expect(await countRequestBodyBytes(null)).toEqual({
			receivedBytes: 0,
			truncated: false,
		});
	});

	it("returns zero for an empty stream", async () => {
		expect(await countRequestBodyBytes(streamOf([]))).toEqual({
			receivedBytes: 0,
			truncated: false,
		});
	});

	it("sums bytes across chunks", async () => {
		const result = await countRequestBodyBytes(
			streamOf([128, 1024, 7, 65_536]),
		);
		expect(result).toEqual({ receivedBytes: 66_695, truncated: false });
	});

	it("does not flag a body exactly at the cap", async () => {
		const result = await countRequestBodyBytes(
			streamOf([MAX_UPLOAD_PROBE_BYTES]),
		);
		expect(result).toEqual({
			receivedBytes: MAX_UPLOAD_PROBE_BYTES,
			truncated: false,
		});
	});

	it("flags and cancels a body that exceeds the cap", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(16));
				controller.enqueue(new Uint8Array(16));
				controller.enqueue(new Uint8Array(16));
			},
			cancel() {
				cancelled = true;
			},
		});
		const result = await countRequestBodyBytes(body, 24);
		expect(result).toEqual({ receivedBytes: 32, truncated: true });
		expect(cancelled).toBe(true);
	});
});

describe("readUploadProbeBody", () => {
	it("retains chunk order and records body receive duration", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Uint8Array.from([1, 2]));
				controller.enqueue(Uint8Array.from([3, 4, 5]));
				controller.close();
			},
		});
		const result = await readUploadProbeBody(body);
		expect(result.receivedBytes).toBe(5);
		expect(result.truncated).toBe(false);
		expect(result.receiveDurationMs).toBeGreaterThanOrEqual(0);
		expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("checkUploadProbeRateLimit", () => {
	beforeEach(() => {
		resetUploadProbeRateLimitForTests();
	});

	it("allows requests within the per-user window and blocks excess probes", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < UPLOAD_PROBE_RATE_LIMIT_MAX_REQUESTS; i++) {
			expect(checkUploadProbeRateLimit("user-1", now + i * 100)).toBe(false);
		}
		expect(checkUploadProbeRateLimit("user-1", now + 2_000)).toBe(true);
		expect(checkUploadProbeRateLimit("user-2", now + 2_000)).toBe(false);
		expect(checkUploadProbeRateLimit("user-1", now + 61_000)).toBe(false);
	});
});

describe("upload-health route contract", () => {
	const route = readFileSync(
		join(process.cwd(), "app/api/desktop/upload-health/route.ts"),
		"utf8",
	);
	const desktopRoot = readFileSync(
		join(process.cwd(), "app/api/desktop/[...route]/root.ts"),
		"utf8",
	);

	it("serves the selected-storage probe under the user prefix, logs deleteObject failures, and enforces rate limiting", () => {
		expect(route).toContain("HttpApiBuilder.group");
		expect(route).toContain("HttpAuthMiddleware");
		expect(route).toContain("/api/desktop/upload-health`");
		expect(route).toContain(
			"isRateLimited(RATE_LIMIT_IDS.DESKTOP_UPLOAD_HEALTH",
		);
		expect(route).toContain("checkUploadProbeRateLimit(user.id)");
		expect(route).toContain('jsonResponse({ error: "rate_limited" }, 429)');
		expect(route).toContain("readUploadProbeBody");
		expect(route).toContain("getAccessibleOrganization");
		expect(route).toContain("getWritableAccessForUser");
		expect(route).toContain("`${user.id}/.cap-upload-health/${randomUUID()}`");
		expect(route).toContain(".putObject(");
		expect(route).toContain("const writeResult = yield* writable.access");
		expect(route).toContain("if (!writeResult.ok)");
		expect(route).toContain(".deleteObject(");
		expect(route).toContain("Effect.retry({");
		expect(route).toContain('Schedule.exponential("100 millis")');
		expect(route).toContain(
			"Failed to clean up upload-health probe object after successful putObject:",
		);
		expect(route).toContain("receiveDurationMs: probe.receiveDurationMs");
		expect(route).toContain('jsonResponse({ error: "probe_too_large" }, 413)');
		expect(route).toContain("apiToHandler(ApiLive)");
	});

	it("keeps the desktop catch-all free of ad-hoc probe handlers", () => {
		expect(desktopRoot).not.toContain('"/upload-health"');
		expect(desktopRoot).not.toContain("countRequestBodyBytes");
	});

	it("declares every probe response shape in the desktop contract", () => {
		const contract = readFileSync(
			join(process.cwd(), "../../packages/web-api-contract/src/desktop.ts"),
			"utf8",
		);
		for (const shape of [
			'"probe_read_failed"',
			'"probe_too_large"',
			'"rate_limited"',
			'"storage_probe_failed"',
		]) {
			expect(contract).toContain(`z.literal(${shape})`);
		}
	});
});
