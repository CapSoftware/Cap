import { describe, expect, it } from "vitest";
import {
	BUSY_COMPLETE_ATTEMPTS,
	COMPLETION_IN_PROGRESS,
	completeRetryPlan,
	isDefinitiveRejection,
	partBytesFor,
	presignBatch,
	retryAfterMs,
	startsLikeAnImageOrDocument,
} from "@/lib/infra-upload";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("console upload part size", () => {
	it("uses 16 MB parts for ordinary files", () => {
		expect(partBytesFor(0)).toBe(16 * MB);
		expect(partBytesFor(30 * MB)).toBe(16 * MB);
		expect(partBytesFor(3 * GB)).toBe(16 * MB);
	});

	it("grows the part so a large file stays near 200 requests", () => {
		const size = 20 * GB;
		const part = partBytesFor(size);
		expect(part % (16 * MB)).toBe(0);
		expect(Math.ceil(size / part)).toBeLessThanOrEqual(200);
	});
});

describe("console upload retry delay", () => {
	it("honors the server's delay in seconds", () => {
		expect(retryAfterMs("12")).toBe(12_000);
		expect(retryAfterMs(" 0.5 ")).toBe(500);
	});

	it("falls back to five seconds when the header is missing or unusable", () => {
		expect(retryAfterMs(null)).toBe(5_000);
		expect(retryAfterMs("")).toBe(5_000);
		expect(retryAfterMs("soon")).toBe(5_000);
		expect(retryAfterMs("-3")).toBe(5_000);
	});

	it("never waits more than a minute", () => {
		expect(retryAfterMs("3600")).toBe(60_000);
	});
});

describe("console upload completion outcome", () => {
	it("treats a refusal as final", () => {
		for (const status of [400, 402, 403, 404, 409]) {
			expect(isDefinitiveRejection(status)).toBe(true);
		}
	});

	it("treats a lost or failed response as unknown", () => {
		for (const status of [0, 408, 429, 500, 502, 503]) {
			expect(isDefinitiveRejection(status)).toBe(false);
		}
	});
});

describe("presignBatch", () => {
	it("asks for up to 20 consecutive parts starting at the one needed", () => {
		expect(presignBatch(1, 200)).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 1),
		);
		expect(presignBatch(21, 200)[0]).toBe(21);
		expect(presignBatch(21, 200)).toHaveLength(20);
	});

	it("stops at the last part", () => {
		expect(presignBatch(195, 200)).toEqual([195, 196, 197, 198, 199, 200]);
		expect(presignBatch(9, 9)).toEqual([9]);
		expect(presignBatch(1, 1)).toEqual([1]);
	});

	it("covers a 200 part upload in 10 requests", () => {
		let requests = 0;
		for (let part = 1; part <= 200; requests++) {
			part += presignBatch(part, 200).length;
		}
		expect(requests).toBe(10);
	});
});

describe("a completion another request is already running", () => {
	it("is not a final rejection, unlike other 4xx answers", () => {
		expect(isDefinitiveRejection(409, COMPLETION_IN_PROGRESS)).toBe(false);
		expect(isDefinitiveRejection(409, "upload_removed")).toBe(true);
		expect(isDefinitiveRejection(409)).toBe(true);
		expect(isDefinitiveRejection(402, "insufficient_credits")).toBe(true);
		expect(isDefinitiveRejection(500, null)).toBe(false);
	});

	it("is retried more times, at a steady pace", () => {
		expect(completeRetryPlan(1, COMPLETION_IN_PROGRESS, 3)).toEqual({
			retry: true,
			waitMs: 3000,
		});
		expect(
			completeRetryPlan(BUSY_COMPLETE_ATTEMPTS - 1, COMPLETION_IN_PROGRESS, 3)
				.retry,
		).toBe(true);
		expect(
			completeRetryPlan(BUSY_COMPLETE_ATTEMPTS, COMPLETION_IN_PROGRESS, 3)
				.retry,
		).toBe(false);
	});

	it("keeps the usual plan for a lost response", () => {
		expect(completeRetryPlan(1, null, 3)).toEqual({
			retry: true,
			waitMs: 1500,
		});
		expect(completeRetryPlan(2, null, 3)).toEqual({
			retry: true,
			waitMs: 3000,
		});
		expect(completeRetryPlan(3, null, 3).retry).toBe(false);
	});
});

describe("a file that is plainly not a video", () => {
	const bytes = (...values: number[]) => new Uint8Array(values);

	it.each([
		["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
		["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46)],
		["GIF", bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00)],
		["PDF", bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37)],
	])("recognises a %s whatever it is named", (_name, head) => {
		expect(startsLikeAnImageOrDocument(head)).toBe(true);
	});

	it.each([
		["MP4", bytes(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70)],
		["WebM", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81)],
		["AVI", bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00)],
		["a short file", bytes(0x89, 0x50)],
		["nothing", bytes()],
	])("does not rule out %s", (_name, head) => {
		expect(startsLikeAnImageOrDocument(head)).toBe(false);
	});
});
