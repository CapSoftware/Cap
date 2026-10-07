import { describe, expect, it } from "vitest";
import {
	countRequestBodyBytes,
	MAX_UPLOAD_PROBE_BYTES,
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

	it("sums bytes across chunks without buffering them", async () => {
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
