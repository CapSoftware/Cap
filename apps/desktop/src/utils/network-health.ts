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
	lastTested: number | null;
	error: string | null;
}

export const SPEED_THRESHOLDS = {
	highSpeedMinMbps: 15,
	mediumSpeedMinMbps: 5,
	lowSpeedMinMbps: 2,
} as const;

export const RESOLUTION_PRESETS = {
	high: 2160,
	medium: 1920,
	low: 1280,
	minimum: 960,
} as const;

type SignalGetter<T> = () => T;
type SignalSetter<T> = (value: T | ((prev: T) => T)) => void;

function createFallbackSignal<T>(
	initial: T,
): [SignalGetter<T>, SignalSetter<T>] {
	let current = initial;
	return [
		() => current,
		(update: T | ((prev: T) => T)) => {
			current =
				typeof update === "function"
					? (update as (prev: T) => T)(current)
					: update;
		},
	];
}

let signalFactory: <T>(initial: T) => [SignalGetter<T>, SignalSetter<T>] =
	createFallbackSignal;

try {
	const solid = await import("solid-js");
	if (solid && typeof solid.createSignal === "function") {
		signalFactory = solid.createSignal;
	}
} catch {
	// Fallback to standalone reactive signal
}

async function getServerUrl(): Promise<string> {
	try {
		const { getConfiguredServerUrl } = await import("./web-api");
		return await getConfiguredServerUrl();
	} catch {
		return "http://localhost:3000";
	}
}

const [networkHealth, setNetworkHealth] = signalFactory<NetworkHealthState>({
	status: "idle",
	lastChecked: null,
	error: null,
});

const [speedTest, setSpeedTest] = signalFactory<SpeedTestState>({
	status: "idle",
	speedMbps: null,
	qualityTier: null,
	recommendedResolution: RESOLUTION_PRESETS.medium,
	lastTested: null,
	error: null,
});

let isRecordingActive = false;
let activeSpeedTestAbort: AbortController | null = null;

export function setRecordingState(active: boolean) {
	isRecordingActive = active;
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
	return isRecordingActive;
}

export function determineQualityTierAndResolution(speedMbps: number): {
	qualityTier: QualityTier;
	recommendedResolution: number;
} {
	if (speedMbps >= SPEED_THRESHOLDS.highSpeedMinMbps) {
		return {
			qualityTier: "high",
			recommendedResolution: RESOLUTION_PRESETS.high,
		};
	}
	if (speedMbps >= SPEED_THRESHOLDS.mediumSpeedMinMbps) {
		return {
			qualityTier: "medium",
			recommendedResolution: RESOLUTION_PRESETS.medium,
		};
	}
	if (speedMbps >= SPEED_THRESHOLDS.lowSpeedMinMbps) {
		return {
			qualityTier: "low",
			recommendedResolution: RESOLUTION_PRESETS.low,
		};
	}
	return {
		qualityTier: "low",
		recommendedResolution: RESOLUTION_PRESETS.minimum,
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

		const testPayload = JSON.stringify({
			type: "screen_recording_health_check",
			timestamp: Date.now(),
			payload: "cap_health_check_ping_data_12345",
		});

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000);

		const response = await fetch(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: testPayload,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`Health check returned HTTP ${response.status}`);
		}

		const data = (await response.json()) as {
			healthy?: boolean;
			status?: string;
		};
		const isHealthy = data.healthy === true || data.status === "ok";

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
	if (isRecordingActive) {
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
		const targetUrl = new URL(
			"/api/desktop/health/speed-test",
			baseUrl,
		).toString();

		const chunkSize = 256 * 1024;
		const buffer = new Uint8Array(chunkSize);
		for (let i = 0; i < chunkSize; i += 64) {
			buffer[i] = i & 0xff;
		}

		const startTime = performance.now();
		const response = await fetch(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
			},
			body: buffer,
			signal: controller.signal,
		});

		const durationMs = performance.now() - startTime;

		if (isRecordingActive) {
			return speedTest().speedMbps;
		}

		if (!response.ok) {
			throw new Error(`Speed test returned HTTP ${response.status}`);
		}

		const calculatedSpeed = calculateSpeedMbps(chunkSize, durationMs);
		const { qualityTier, recommendedResolution } =
			determineQualityTierAndResolution(calculatedSpeed);

		setSpeedTest({
			status: "completed",
			speedMbps: calculatedSpeed,
			qualityTier,
			recommendedResolution,
			lastTested: Date.now(),
			error: null,
		});

		try {
			const { generalSettingsStore } = await import("~/store");
			await generalSettingsStore.set({
				instantModeMaxResolution: recommendedResolution,
			});
		} catch {}

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
		if (!isRecordingActive) {
			void runSpeedTest();
		}
	}, 45_000);

	return () => {
		clearInterval(interval);
		activeSpeedTestAbort?.abort();
	};
}

export { networkHealth, speedTest };
