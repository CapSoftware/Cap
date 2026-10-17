import type { UploadHealthStatus } from "./tauri";

export type UploadHealthDisplay = {
	severity: "ok" | "warn" | "error" | "muted";
	label: string;
	detail: string | null;
	showSupport: boolean;
};

export function formatUploadMbps(mbps: number): string {
	if (!Number.isFinite(mbps) || mbps < 0) return "0.0";
	return mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1);
}

export function uploadHealthDisplay(
	status: UploadHealthStatus,
): UploadHealthDisplay {
	switch (status.state) {
		case "checking":
			return {
				severity: "muted",
				label: "Checking upload…",
				detail: null,
				showSupport: false,
			};
		case "healthy":
			return {
				severity: "ok",
				label: `${formatUploadMbps(status.uploadMbps ?? 0)} Mbps`,
				detail: null,
				showSupport: false,
			};
		case "degraded":
			return {
				severity: "warn",
				label: `${formatUploadMbps(status.uploadMbps ?? 0)} Mbps`,
				detail:
					"Upload speed is low — Instant recordings will use a lower resolution to keep uploads reliable",
				showSupport: false,
			};
		case "failed":
			return {
				severity: "error",
				label: "Upload check failed",
				detail: status.detail,
				showSupport: true,
			};
		case "endpointUnavailable":
			return {
				severity: "muted",
				label: "Upload check unavailable",
				detail:
					"Your Cap server does not support upload checks yet — recordings are unaffected",
				showSupport: false,
			};
		case "unauthenticated":
			return {
				severity: "muted",
				label: "Sign in to check uploads",
				detail: null,
				showSupport: false,
			};
		case "unknown":
			return {
				severity: "muted",
				label: "Upload speed unknown",
				detail: null,
				showSupport: false,
			};
	}
}

export function uploadHealthVisible(status: UploadHealthStatus): boolean {
	return status.state !== "endpointUnavailable";
}
