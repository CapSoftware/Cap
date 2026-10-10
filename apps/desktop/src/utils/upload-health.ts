import { commands, type UploadHealthStatus } from "./tauri";

export type { UploadHealthKind, UploadHealthStatus } from "./tauri";

export type UploadHealthPresentation = {
	label: string;
	detail: string;
	tone: "neutral" | "good" | "warning" | "danger";
};

export const getUploadHealthStatus = commands.getUploadHealthStatus;

export const refreshUploadHealthStatus = commands.refreshUploadHealthStatus;

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

	if (status.kind === "unsupported") {
		return {
			label: "Upload check unavailable",
			detail: "Server unsupported",
			tone: "neutral",
		};
	}

	if (status.kind === "unavailable") {
		return {
			label: "API check failed",
			detail: "Quality may be limited",
			tone: "danger",
		};
	}

	const speed =
		status.uploadMbps != null &&
		Number.isFinite(status.uploadMbps) &&
		status.uploadMbps >= 0
			? formatUploadMbps(status.uploadMbps)
			: null;
	if (status.kind === "slow") {
		return {
			label: "API upload slow",
			detail: speed ? `~${speed}` : "Not measured",
			tone: "warning",
		};
	}

	return {
		label: "API estimate",
		detail: speed ? `~${speed}` : "Not measured",
		tone: "good",
	};
}
