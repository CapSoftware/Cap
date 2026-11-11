import { describe, expect, it } from "vitest";
import {
	isDefinitiveRejection,
	partBytesFor,
	retryAfterMs,
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
