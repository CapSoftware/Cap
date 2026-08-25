import { invoke } from "@tauri-apps/api/core";

export type UploadHealthKind = "unknown" | "healthy" | "slow" | "unavailable";

export type UploadHealthStatus = {
	kind: UploadHealthKind;
	uploadMbps: number | null;
	maxInstantResolution: number | null;
	checkedAtUnixMs: number | null;
	stale: boolean;
	message: string;
};

export type UploadHealthPresentation = {
	label: string;
	detail: string;
	tone: "neutral" | "good" | "warning" | "danger";
};

export const getUploadHealthStatus = () =>
	invoke<UploadHealthStatus>("get_upload_health_status");

export const refreshUploadHealthStatus = () =>
	invoke<UploadHealthStatus>("refresh_upload_health_status");

export function formatUploadMbps(uploadMbps: number) {
	if (uploadMbps >= 10) return `${Math.round(uploadMbps)} Mbps`;
	return `${uploadMbps.toFixed(1)} Mbps`;
}

export function describeUploadHealth(
	status: UploadHealthStatus | null | undefined,
): UploadHealthPresentation {
	if (!status || status.kind === "unknown") {
		return {
			label: "Upload health",
			detail: "Not checked",
			tone: "neutral",
		};
	}

	if (status.stale) {
		return {
			label: "Upload health",
			detail: "Check is stale",
			tone: "neutral",
		};
	}

	if (status.kind === "unavailable") {
		return {
			label: "Upload offline",
			detail: "Instant capped",
			tone: "danger",
		};
	}

	const speed =
		status.uploadMbps != null ? formatUploadMbps(status.uploadMbps) : null;
	if (status.kind === "slow") {
		return {
			label: "Upload slow",
			detail: speed ? `${speed}, capped` : "Instant capped",
			tone: "warning",
		};
	}

	return {
		label: "Upload ready",
		detail: speed ?? "Ready",
		tone: "good",
	};
}
