import { Channel, invoke } from "@tauri-apps/api/core";

const navigationTargetKey = "cap:recording-health-target";

export type RecordingHealthStatus =
	| "healthy"
	| "degraded"
	| "damaged"
	| "missing";
export type RecordingHealthSeverity = "info" | "warning" | "critical";
export type RecordingHealthMediaKind = "video" | "audio" | "data" | "directory";
export type RecordingHealthMode = "studio" | "instant" | "unknown";
export type RecordingRepairStatus = "performed" | "failed" | "skipped";

export type RecordingHealthIssue = {
	severity: RecordingHealthSeverity;
	code: string;
	title: string;
	detail: string;
	path: string | null;
	repairable: boolean;
};

export type RecordingHealthFile = {
	label: string;
	path: string;
	kind: RecordingHealthMediaKind;
	required: boolean;
	exists: boolean;
	sizeBytes: number | null;
	validContainer: boolean | null;
	decodable: boolean | null;
	durationSecs: number | null;
};

export type RecordingRecoverableSummary = {
	available: boolean;
	segmentCount: number;
	estimatedDurationSecs: number;
};

export type RecordingRepairAttempt = {
	status: RecordingRepairStatus;
	title: string;
	detail: string;
	path: string | null;
};

export type RecordingHealthReport = {
	projectPath: string;
	prettyName: string;
	mode: RecordingHealthMode;
	recordingStatus: string;
	status: RecordingHealthStatus;
	score: number;
	repairable: boolean;
	issues: RecordingHealthIssue[];
	files: RecordingHealthFile[];
	recoverable: RecordingRecoverableSummary;
	repairs: RecordingRepairAttempt[];
};

export type RecordingHealthProgressPhase =
	| "preparing"
	| "scanning"
	| "complete";

export type RecordingHealthProgress = {
	phase: RecordingHealthProgressPhase;
	completed: number;
	total: number;
	currentPath: string | null;
	currentName: string | null;
	message: string;
	elapsedSecs: number;
	etaSecs: number | null;
	report: RecordingHealthReport | null;
};

export type RecordingHealthNavigationTarget = {
	projectPath: string;
	autoRepair: boolean;
	createdAt: number;
};

function isNavigationTarget(
	value: unknown,
): value is RecordingHealthNavigationTarget {
	return (
		typeof value === "object" &&
		value !== null &&
		"projectPath" in value &&
		"autoRepair" in value &&
		"createdAt" in value &&
		typeof value.projectPath === "string" &&
		typeof value.autoRepair === "boolean" &&
		typeof value.createdAt === "number"
	);
}

export function storeRecordingHealthTarget(
	projectPath: string,
	autoRepair: boolean,
) {
	if (typeof window === "undefined") return;

	try {
		window.localStorage.setItem(
			navigationTargetKey,
			JSON.stringify({
				projectPath,
				autoRepair,
				createdAt: Date.now(),
			} satisfies RecordingHealthNavigationTarget),
		);
	} catch {
		return;
	}
}

export function consumeRecordingHealthTarget() {
	if (typeof window === "undefined") return null;

	try {
		const raw = window.localStorage.getItem(navigationTargetKey);
		window.localStorage.removeItem(navigationTargetKey);
		if (!raw) return null;

		const value: unknown = JSON.parse(raw);
		return isNavigationTarget(value) ? value : null;
	} catch {
		return null;
	}
}

export function clearRecordingHealthTarget() {
	if (typeof window === "undefined") return;

	try {
		window.localStorage.removeItem(navigationTargetKey);
	} catch {
		return;
	}
}

function unregisterChannel<T>(channel: Channel<T>) {
	const internals = (
		globalThis as {
			__TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
		}
	).__TAURI_INTERNALS__;
	internals?.unregisterCallback?.(channel.id);
}

export function scanRecordingHealth(
	onProgress?: (progress: RecordingHealthProgress) => void,
) {
	if (!onProgress) {
		return invoke<RecordingHealthReport[]>("scan_recording_health");
	}

	const progress = new Channel<RecordingHealthProgress>(onProgress);
	return invoke<RecordingHealthReport[]>(
		"scan_recording_health_with_progress",
		{
			progress,
		},
	).finally(() => unregisterChannel(progress));
}

export function inspectRecordingHealth(projectPath: string) {
	return invoke<RecordingHealthReport>("inspect_recording_health", {
		projectPath,
	});
}

export function repairRecordingHealth(projectPath: string) {
	return invoke<RecordingHealthReport>("repair_recording_health", {
		projectPath,
	});
}
