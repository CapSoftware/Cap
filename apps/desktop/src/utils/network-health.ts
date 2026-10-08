import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createSignal } from "solid-js";

export type QualityTier = "high" | "medium" | "low";

export interface NetworkHealthState {
	status: "idle" | "checking" | "healthy" | "unhealthy";
	lastChecked: number | null;
	error: string | null;
}

export interface SpeedTestState {
	status: "idle" | "running" | "completed" | "error";
	speedMbps: number | null;
	qualityTier: QualityTier | null;
	recommendedResolution: number;
	recommendedLabel: string;
	lastTested: number | null;
	error: string | null;
}

export const SPEED_THRESHOLDS = {
	highSpeedMinMbps: 15,
	mediumSpeedMinMbps: 5,
	lowSpeedMinMbps: 2,
} as const;

export const RESOLUTION_PRESETS = {
	ultra: 3840,
	high: 1920,
	medium: 1280,
	low: 960,
} as const;

export function formatResolutionLabel(width: number): string {
	if (width >= 3840) return "4K";
	if (width >= 2560) return "1440p";
	if (width >= 1920) return "1080p";
	if (width >= 1280) return "720p";
	return "540p";
}

function getHttpFetch(): typeof globalThis.fetch {
	if (typeof window !== "undefined") {
		return tauriFetch;
	}
	return globalThis.fetch;
}

async function getServerUrl(): Promise<string> {
	try {
		const { getConfiguredServerUrl } = await import("./web-api");
		return await getConfiguredServerUrl();
	} catch {
		return "http://localhost:3000";
	}
}

const [networkHealth, setNetworkHealth] = createSignal<NetworkHealthState>({
	status: "idle",
	lastChecked: null,
	error: null,
});

const [speedTest, setSpeedTest] = createSignal<SpeedTestState>({
	status: "idle",
	speedMbps: null,
	qualityTier: null,
	recommendedResolution: RESOLUTION_PRESETS.high,
	recommendedLabel: "1080p",
	lastTested: null,
	error: null,
});

const [isRecordingSignal, setIsRecordingSignal] = createSignal(false);
let activeSpeedTestAbort: AbortController | null = null;

export function setRecordingState(active: boolean) {
	setIsRecordingSignal(active);
	if (active && activeSpeedTestAbort) {
		activeSpeedTestAbort.abort();
		activeSpeedTestAbort = null;
		setSpeedTest((prev) => ({
			...prev,
			status: prev.speedMbps !== null ? "completed" : "idle",
		}));
	}
}

export function isRecordingInProgress(): boolean {
	return isRecordingSignal();
}

export function determineQualityTierAndResolution(speedMbps: number): {
	qualityTier: QualityTier;
	recommendedResolution: number;
	recommendedLabel: string;
} {
	if (speedMbps >= 25) {
		return {
			qualityTier: "high",
			recommendedResolution: RESOLUTION_PRESETS.ultra,
			recommendedLabel: "4K",
		};
	}
	if (speedMbps >= SPEED_THRESHOLDS.highSpeedMinMbps) {
		return {
			qualityTier: "high",
			recommendedResolution: RESOLUTION_PRESETS.high,
			recommendedLabel: "1080p",
		};
	}
	if (speedMbps >= SPEED_THRESHOLDS.mediumSpeedMinMbps) {
		return {
			qualityTier: "medium",
			recommendedResolution: RESOLUTION_PRESETS.medium,
			recommendedLabel: "720p",
		};
	}
	return {
		qualityTier: "low",
		recommendedResolution: RESOLUTION_PRESETS.low,
		recommendedLabel: "540p",
	};
}

export function calculateSpeedMbps(bytes: number, durationMs: number): number {
	if (durationMs <= 0 || bytes <= 0) return 0;
	const durationSeconds = durationMs / 1000;
	const bits = bytes * 8;
	const mbps = bits / (durationSeconds * 1_000_000);
	return Math.round(mbps * 10) / 10;
}

export async function runUploadHealthCheck(): Promise<boolean> {
	setNetworkHealth((prev) => ({
		...prev,
		status: "checking",
		error: null,
	}));

	try {
		const baseUrl = await getServerUrl();
		const targetUrl = new URL("/api/desktop/health", baseUrl).toString();

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000);

		const fetchFn = getHttpFetch();
		const response = await fetchFn(targetUrl, {
			method: "GET",
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`Health check returned HTTP ${response.status}`);
		}

		const data = (await response.json()) as {
			status?: string;
		};
		const isHealthy = data.status === "ok";

		if (!isHealthy) {
			throw new Error("Server responded with unhealthy status");
		}

		setNetworkHealth({
			status: "healthy",
			lastChecked: Date.now(),
			error: null,
		});
		return true;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Upload health check failed";
		setNetworkHealth({
			status: "unhealthy",
			lastChecked: Date.now(),
			error: errorMessage,
		});
		return false;
	}
}

export async function runSpeedTest(): Promise<number | null> {
	if (isRecordingSignal()) {
		return speedTest().speedMbps;
	}

	activeSpeedTestAbort?.abort();
	const controller = new AbortController();
	activeSpeedTestAbort = controller;

	setSpeedTest((prev) => ({
		...prev,
		status: "running",
		error: null,
	}));

	try {
		const baseUrl = await getServerUrl();
		const targetUrl = new URL("/api/desktop/health", baseUrl).toString();
		const fetchFn = getHttpFetch();

		const warmupResponse = await fetchFn(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ payload: "ping" }),
			signal: controller.signal,
		});

		if (!warmupResponse.ok) {
			throw new Error(`Warmup failed with HTTP ${warmupResponse.status}`);
		}

		if (isRecordingSignal()) {
			return speedTest().speedMbps;
		}

		const rttStart = performance.now();
		const rttResponse = await fetchFn(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ payload: "ping" }),
			signal: controller.signal,
		});
		const baselineRttMs = performance.now() - rttStart;

		if (!rttResponse.ok) {
			throw new Error(`Latency probe returned HTTP ${rttResponse.status}`);
		}

		if (isRecordingSignal()) {
			return speedTest().speedMbps;
		}

		const sampleBytes = 512 * 1024;
		const sampleData = "a".repeat(sampleBytes);
		const testPayload = JSON.stringify({
			payload: sampleData,
		});

		const sampleCount = 2;
		const measuredSpeeds: number[] = [];

		for (let i = 0; i < sampleCount; i++) {
			if (isRecordingSignal()) {
				return speedTest().speedMbps;
			}

			const sampleStartTime = performance.now();
			const response = await fetchFn(targetUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: testPayload,
				signal: controller.signal,
			});
			const rawDurationMs = performance.now() - sampleStartTime;

			if (isRecordingSignal()) {
				return speedTest().speedMbps;
			}

			if (!response.ok) {
				throw new Error(`Speed test returned HTTP ${response.status}`);
			}

			const result = (await response.json()) as {
				success?: boolean;
				bytesReceived?: number;
			};

			if (!result.success || typeof result.bytesReceived !== "number") {
				throw new Error("Invalid speed test server response");
			}

			if (result.bytesReceived < sampleBytes) {
				throw new Error(
					`Incomplete upload: expected ${sampleBytes} bytes, received ${result.bytesReceived}`,
				);
			}

			const netDurationMs = Math.max(
				10,
				rawDurationMs - Math.min(baselineRttMs, rawDurationMs * 0.8),
			);
			measuredSpeeds.push(
				calculateSpeedMbps(result.bytesReceived, netDurationMs),
			);
		}

		const calculatedSpeed = Math.max(...measuredSpeeds);
		const { qualityTier, recommendedResolution, recommendedLabel } =
			determineQualityTierAndResolution(calculatedSpeed);

		setSpeedTest({
			status: "completed",
			speedMbps: calculatedSpeed,
			qualityTier,
			recommendedResolution,
			recommendedLabel,
			lastTested: Date.now(),
			error: null,
		});

		setNetworkHealth({
			status: "healthy",
			lastChecked: Date.now(),
			error: null,
		});

		activeSpeedTestAbort = null;
		return calculatedSpeed;
	} catch (error) {
		if (controller.signal.aborted) {
			return speedTest().speedMbps;
		}

		const errorMessage =
			error instanceof Error ? error.message : "Speed test failed";
		setSpeedTest((prev) => ({
			...prev,
			status: "error",
			error: errorMessage,
		}));
		activeSpeedTestAbort = null;
		return null;
	}
}

export function initNetworkHealthMonitoring(): () => void {
	void runUploadHealthCheck();
	void runSpeedTest();

	const interval = setInterval(() => {
		if (!isRecordingSignal()) {
			if (networkHealth().status !== "healthy") {
				void runUploadHealthCheck();
			}
			void runSpeedTest();
		}
	}, 45_000);

	return () => {
		clearInterval(interval);
		activeSpeedTestAbort?.abort();
	};
}

export { networkHealth, speedTest };
