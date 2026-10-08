import { describe, expect, it, vi } from "vitest";
import {
	calculateSpeedMbps,
	determineQualityTierAndResolution,
	formatResolutionLabel,
	isRecordingInProgress,
	networkHealth,
	runSpeedTest,
	runUploadHealthCheck,
	setRecordingState,
	speedTest,
} from "./network-health";

describe("network-health speed test & quality adaptation", () => {
	it("correctly maps speeds to adaptive quality tiers and resolution labels", () => {
		const ultraTier = determineQualityTierAndResolution(30);
		expect(ultraTier.qualityTier).toBe("high");
		expect(ultraTier.recommendedResolution).toBe(3840);
		expect(ultraTier.recommendedLabel).toBe("4K");

		const highTier = determineQualityTierAndResolution(18);
		expect(highTier.qualityTier).toBe("high");
		expect(highTier.recommendedResolution).toBe(1920);
		expect(highTier.recommendedLabel).toBe("1080p");

		const mediumTier = determineQualityTierAndResolution(8);
		expect(mediumTier.qualityTier).toBe("medium");
		expect(mediumTier.recommendedResolution).toBe(1280);
		expect(mediumTier.recommendedLabel).toBe("720p");

		const lowTier = determineQualityTierAndResolution(1.5);
		expect(lowTier.qualityTier).toBe("low");
		expect(lowTier.recommendedResolution).toBe(960);
		expect(lowTier.recommendedLabel).toBe("540p");

		expect(formatResolutionLabel(3840)).toBe("4K");
		expect(formatResolutionLabel(1920)).toBe("1080p");
		expect(formatResolutionLabel(1280)).toBe("720p");
		expect(formatResolutionLabel(960)).toBe("540p");
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

	it("manages health check state transitions and clears errors upon recovery", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ status: "ok" }),
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

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ status: "ok" }),
		} as Response);
		const recovery = await runUploadHealthCheck();
		expect(recovery).toBe(true);
		expect(networkHealth().status).toBe("healthy");
		expect(networkHealth().error).toBeNull();

		globalThis.fetch = originalFetch;
	});
});
