import { describe, expect, it, vi } from "vitest";
import {
	calculateSpeedMbps,
	determineQualityTierAndResolution,
	isRecordingInProgress,
	networkHealth,
	runSpeedTest,
	runUploadHealthCheck,
	setRecordingState,
	speedTest,
} from "./network-health";

describe("network-health speed test & quality adaptation", () => {
	it("correctly maps speeds to adaptive quality tiers and resolutions", () => {
		const highTier = determineQualityTierAndResolution(25);
		expect(highTier.qualityTier).toBe("high");
		expect(highTier.recommendedResolution).toBe(2160);

		const mediumTier = determineQualityTierAndResolution(10);
		expect(mediumTier.qualityTier).toBe("medium");
		expect(mediumTier.recommendedResolution).toBe(1920);

		const lowTier = determineQualityTierAndResolution(3.5);
		expect(lowTier.qualityTier).toBe("low");
		expect(lowTier.recommendedResolution).toBe(1280);

		const minTier = determineQualityTierAndResolution(1.2);
		expect(minTier.qualityTier).toBe("low");
		expect(minTier.recommendedResolution).toBe(960);
	});

	it("calculates upload speed in Mbps accurately", () => {
		const oneMegabyte = 1024 * 1024;
		const durationMs = 1000;
		const speed = calculateSpeedMbps(oneMegabyte, durationMs);
		expect(speed).toBeCloseTo(8.4, 0);

		expect(calculateSpeedMbps(0, 1000)).toBe(0);
		expect(calculateSpeedMbps(1024, 0)).toBe(0);
	});

	it("does not perform speed checks once recording has already started", async () => {
		setRecordingState(true);
		expect(isRecordingInProgress()).toBe(true);

		const result = await runSpeedTest();
		expect(result).toBe(speedTest().speedMbps);

		setRecordingState(false);
		expect(isRecordingInProgress()).toBe(false);
	});

	it("manages health check state transitions", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ status: "ok", healthy: true }),
		} as Response);

		const success = await runUploadHealthCheck();
		expect(success).toBe(true);
		expect(networkHealth().status).toBe("healthy");
		expect(networkHealth().error).toBeNull();

		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error("Connection refused"));
		const failure = await runUploadHealthCheck();
		expect(failure).toBe(false);
		expect(networkHealth().status).toBe("unhealthy");
		expect(networkHealth().error).toContain("Connection refused");

		globalThis.fetch = originalFetch;
	});
});
