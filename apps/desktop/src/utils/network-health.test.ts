import { describe, expect, it, vi } from "vitest";
import {
	calculateSpeedMbps,
	determineQualityTierAndResolution,
	formatResolutionLabel,
	initNetworkHealthMonitoring,
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

	it("handles rate limiting and server errors gracefully during speed tests", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
		} as Response);

		const result = await runSpeedTest();
		expect(result).toBeNull();
		expect(speedTest().status).toBe("error");
		expect(speedTest().error).toContain("429");

		globalThis.fetch = originalFetch;
	});

	it("clears unhealthy network health status upon successful speed test completion", async () => {
		const originalFetch = globalThis.fetch;

		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error("Offline: network unreachable"));
		await runUploadHealthCheck();
		expect(networkHealth().status).toBe("unhealthy");
		expect(networkHealth().error).toContain("Offline: network unreachable");

		const mockFetch = vi
			.fn()
			.mockImplementation((_url: string, init?: RequestInit) => {
				const body =
					typeof init?.body === "string" ? JSON.parse(init.body) : {};
				if (body.payload === "ping") {
					return Promise.resolve({
						ok: true,
						json: async () => ({
							success: true,
							bytesReceived: 4,
							timestamp: Date.now(),
						}),
					} as Response);
				}
				return Promise.resolve({
					ok: true,
					json: async () => ({
						success: true,
						bytesReceived: 512 * 1024,
						timestamp: Date.now(),
					}),
				} as Response);
			});
		globalThis.fetch = mockFetch;

		const speed = await runSpeedTest();
		expect(speed).toBeGreaterThan(0);
		expect(speedTest().status).toBe("completed");
		expect(speedTest().error).toBeNull();
		expect(networkHealth().status).toBe("healthy");
		expect(networkHealth().error).toBeNull();
		expect(mockFetch).toHaveBeenCalledTimes(4);

		globalThis.fetch = originalFetch;
	});

	it("prevents delayed health check failure from overwriting newer successful status", async () => {
		const originalFetch = globalThis.fetch;

		let delayedReject!: (err: Error) => void;
		let getEnteredMock = false;
		const delayedPromise = new Promise<Response>((_, reject) => {
			delayedReject = reject;
		});
		delayedPromise.catch(() => {});

		globalThis.fetch = vi
			.fn()
			.mockImplementation((_url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					getEnteredMock = true;
					return delayedPromise;
				}

				const body =
					typeof init?.body === "string" ? JSON.parse(init.body) : {};
				if (body.payload === "ping") {
					return Promise.resolve({
						ok: true,
						json: async () => ({
							success: true,
							bytesReceived: 4,
							timestamp: Date.now(),
						}),
					} as Response);
				}
				return Promise.resolve({
					ok: true,
					json: async () => ({
						success: true,
						bytesReceived: 512 * 1024,
						timestamp: Date.now(),
					}),
				} as Response);
			});

		const pendingCheck = runUploadHealthCheck();
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(getEnteredMock).toBe(true);

		await runSpeedTest();
		expect(networkHealth().status).toBe("healthy");

		delayedReject(new Error("Late network timeout"));
		const checkResult = await pendingCheck;
		expect(checkResult).toBe(false);

		expect(networkHealth().status).toBe("healthy");
		expect(networkHealth().error).toBeNull();

		globalThis.fetch = originalFetch;
	});

	it("stops scheduled speed tests after monitoring is disposed", async () => {
		const originalFetch = globalThis.fetch;
		let postCallCount = 0;

		let resolveHealth!: (res: Response) => void;
		const healthPromise = new Promise<Response>((resolve) => {
			resolveHealth = resolve;
		});

		globalThis.fetch = vi
			.fn()
			.mockImplementation((_url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return healthPromise;
				}
				postCallCount++;
				return Promise.resolve({
					ok: true,
					json: async () => ({
						success: true,
						bytesReceived: 512 * 1024,
						timestamp: Date.now(),
					}),
				} as Response);
			});

		const stopMonitoring = initNetworkHealthMonitoring();
		stopMonitoring();

		resolveHealth({
			ok: true,
			json: async () => ({ status: "ok" }),
		} as Response);
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(postCallCount).toBe(0);

		globalThis.fetch = originalFetch;
	});
});
