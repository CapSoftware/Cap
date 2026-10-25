import { describe, expect, it } from "vitest";
import {
	describeUploadHealthBadge,
	formatUploadMbps,
} from "./upload-health-indicator";

describe("upload-health-indicator helpers", () => {
	it("formats zero and positive upload speeds without treating 0 as falsy", () => {
		expect(formatUploadMbps(0)).toBe("0.0 Mbps");
		expect(formatUploadMbps(12.34)).toBe("12.3 Mbps");

		const zeroSpeedBadge = describeUploadHealthBadge({
			state: "degraded",
			uploadMbps: 0,
			recommendedMaxResolution: 960,
			qualityLabel: "540p",
			message: "Slow upload",
			supportUrl: "https://cap.so/support",
			checkedAtUnixMs: 1700000000000,
		});
		expect(zeroSpeedBadge.label).toBe("0.0 Mbps · 540p");
		expect(zeroSpeedBadge.tone).toBe("degraded");
	});

	it("describes healthy and unavailable states accurately", () => {
		const healthyBadge = describeUploadHealthBadge({
			state: "healthy",
			uploadMbps: 18.6,
			recommendedMaxResolution: 1920,
			qualityLabel: "1080p",
			message: "Upload ready",
			supportUrl: "https://cap.so/support",
			checkedAtUnixMs: 1700000000000,
		});
		expect(healthyBadge.label).toBe("18.6 Mbps · 1080p");
		expect(healthyBadge.tone).toBe("healthy");

		const unavailableBadge = describeUploadHealthBadge({
			state: "unavailable",
			uploadMbps: null,
			recommendedMaxResolution: 960,
			qualityLabel: "540p",
			message: "Upload check failed",
			supportUrl: "https://cap.so/support",
			checkedAtUnixMs: 1700000000000,
		});
		expect(unavailableBadge.label).toBe("Upload issue · Contact support");
		expect(unavailableBadge.tone).toBe("error");
	});
});
