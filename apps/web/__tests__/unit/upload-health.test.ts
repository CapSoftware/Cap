import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	countRequestBodyBytes,
	MAX_UPLOAD_PROBE_BYTES,
	readUploadProbeBody,
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
	it("retains chunk order for the selected storage probe", async () => {
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
		expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
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

	it("serves the selected-storage probe through authenticated HttpApi", () => {
		expect(route).toContain("HttpApiBuilder.group");
		expect(route).toContain("HttpAuthMiddleware");
		expect(route).toContain("/api/desktop/upload-health`");
		expect(route).toContain("readUploadProbeBody");
		expect(route).toContain("getWritableAccessForUser");
		expect(route).toContain(".putObject(");
		expect(route).toContain(".deleteObject(");
		expect(route).toContain("Effect.retry({");
		expect(route).toContain('Schedule.exponential("100 millis")');
		expect(route).not.toContain("Effect.catchAll(() => Effect.void)");
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
			'"storage_probe_failed"',
		]) {
			expect(contract).toContain(`z.literal(${shape})`);
		}
	});
});
