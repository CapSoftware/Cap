import { describe, expect, it } from "vitest";
import type { UploadHealthStatus } from "./tauri";
import {
	formatUploadMbps,
	uploadHealthDisplay,
	uploadHealthVisible,
} from "./upload-health";

function status(overrides: Partial<UploadHealthStatus>): UploadHealthStatus {
	return {
		state: "unknown",
		uploadMbps: null,
		recommendedMaxWidth: null,
		detail: null,
		checkedAt: null,
		recordingActive: false,
		...overrides,
	};
}

describe("formatUploadMbps", () => {
	it("shows one decimal under 10 Mbps and whole numbers above", () => {
		expect(formatUploadMbps(0)).toBe("0.0");
		expect(formatUploadMbps(2.34)).toBe("2.3");
		expect(formatUploadMbps(9.96)).toBe("10.0");
		expect(formatUploadMbps(10)).toBe("10");
		expect(formatUploadMbps(47.4)).toBe("47");
	});

	it("clamps non-finite and negative values to zero", () => {
		expect(formatUploadMbps(Number.NaN)).toBe("0.0");
		expect(formatUploadMbps(Number.POSITIVE_INFINITY)).toBe("0.0");
		expect(formatUploadMbps(-3)).toBe("0.0");
	});
});

describe("uploadHealthDisplay", () => {
	it("shows the measured speed for healthy and degraded results", () => {
		expect(
			uploadHealthDisplay(status({ state: "healthy", uploadMbps: 41.2 })).label,
		).toBe("41 Mbps");
		expect(
			uploadHealthDisplay(status({ state: "degraded", uploadMbps: 1.9 })).label,
		).toBe("1.9 Mbps");
	});

	it("marks degraded results as a warning without support guidance", () => {
		const display = uploadHealthDisplay(
			status({ state: "degraded", uploadMbps: 3 }),
		);
		expect(display.severity).toBe("warn");
		expect(display.showSupport).toBe(false);
		expect(display.detail).toContain("lower resolution");
	});

	it("offers support guidance only on failure", () => {
		for (const state of [
			"checking",
			"healthy",
			"degraded",
			"endpointUnavailable",
			"unauthenticated",
			"unknown",
		] as const) {
			expect(uploadHealthDisplay(status({ state })).showSupport).toBe(false);
		}
		const failed = uploadHealthDisplay(
			status({ state: "failed", detail: "timed out" }),
		);
		expect(failed.showSupport).toBe(true);
		expect(failed.severity).toBe("error");
		expect(failed.detail).toBe("timed out");
	});
});

describe("uploadHealthVisible", () => {
	it("hides the indicator only when the endpoint is missing", () => {
		expect(uploadHealthVisible(status({ state: "endpointUnavailable" }))).toBe(
			false,
		);
		for (const state of [
			"unknown",
			"checking",
			"healthy",
			"degraded",
			"failed",
			"unauthenticated",
		] as const) {
			expect(uploadHealthVisible(status({ state }))).toBe(true);
		}
	});
});
