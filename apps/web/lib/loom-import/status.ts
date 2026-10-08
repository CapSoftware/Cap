import type {
	LoomImportItemStatus,
	LoomImportJobStatus,
} from "@cap/database/schema";

export type { LoomImportItemStatus, LoomImportJobStatus };

export type LoomImportDisplayStatus =
	| "checking"
	| "ready"
	| "queued"
	| "importing"
	| "imported"
	| "failed"
	| "skipped"
	| "cancelled";

export type LoomImportStage =
	| "starting"
	| "waiting"
	| "downloading"
	| "processing"
	| "finishing";

export type LoomImportItemSource = {
	status: LoomImportItemStatus;
	videoId: string | null;
	error: string | null;
	videoExists: boolean;
	uploadPhase: string | null;
	uploadProgress: number | null;
	uploadMessage: string | null;
	uploadError: string | null;
};

export type LoomImportItemState = {
	status: LoomImportDisplayStatus;
	stage?: LoomImportStage;
	progress?: number;
	error?: string;
};

export type LoomImportCounts = Record<LoomImportDisplayStatus, number> & {
	total: number;
};

export type LoomImportItemView = {
	id: string;
	row: number;
	url: string;
	loomId: string | null;
	title: string | null;
	email: string | null;
	space: string | null;
	status: LoomImportDisplayStatus;
	stage?: LoomImportStage;
	progress?: number;
	error?: string;
	videoId: string | null;
	recordedAt: string | null;
	duration: number | null;
	thumb: string | null;
	v: number;
};

export type LoomImportJobView = {
	id: string;
	fileName: string;
	status: LoomImportJobStatus;
	totalCount: number;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	createdByMe: boolean;
	canStart: boolean;
	isPro: boolean;
	isAdmin: boolean;
};

export type LoomImportSummaryView = {
	counts: LoomImportCounts;
	totalDuration: number;
	importedDuration: number;
	owners: number;
};

export type LoomImportSnapshot = {
	job: LoomImportJobView;
	summary: LoomImportSummaryView | null;
	items: LoomImportItemView[];
	cursor: number;
	full: boolean;
};

export const LOOM_IMPORT_TERMINAL_STATUSES: ReadonlySet<LoomImportDisplayStatus> =
	new Set(["imported", "failed", "skipped", "cancelled"]);

export const LOOM_IMPORT_DELETED_VIDEO_ERROR = "The imported Cap was deleted.";

export function loomImportWaitingStatus(
	jobStatus: LoomImportJobStatus,
): "ready" | "queued" {
	return jobStatus === "awaiting_upgrade" || jobStatus === "checking"
		? "ready"
		: "queued";
}

export type LoomImportSettleSource = {
	status: LoomImportItemStatus;
	videoExists: boolean;
	uploadPhase: string | null;
	uploadError: string | null;
};

export type LoomImportSettlement =
	| { status: "complete"; error: null }
	| { status: "failed"; error: string };

export function settleLoomImportItem(
	source: LoomImportSettleSource,
): LoomImportSettlement | null {
	if (!source.videoExists) {
		return { status: "failed", error: LOOM_IMPORT_DELETED_VIDEO_ERROR };
	}
	if (source.status === "complete") return null;
	if (source.uploadPhase === null || source.uploadPhase === "complete") {
		return { status: "complete", error: null };
	}
	if (source.uploadPhase === "error") {
		return {
			status: "failed",
			error: (source.uploadError || "Loom import failed.").slice(0, 512),
		};
	}
	return null;
}

function importStage(
	phase: string | null,
	progress: number,
	message: string | null,
): LoomImportStage {
	if (phase === "uploading") return "starting";
	if (phase === "generating_thumbnail" || progress >= 80) return "finishing";
	if (message?.startsWith("Queued")) return "waiting";
	if (progress < 10) return "downloading";
	return "processing";
}

export function deriveLoomImportItemState(
	source: LoomImportItemSource,
	jobStatus: LoomImportJobStatus,
): LoomImportItemState {
	switch (source.status) {
		case "pending":
			return { status: "checking" };
		case "ready":
			return { status: loomImportWaitingStatus(jobStatus) };
		case "skipped":
			return { status: "skipped", error: source.error ?? undefined };
		case "cancelled":
			return { status: "cancelled" };
		default:
			break;
	}

	if (!source.videoId) {
		if (source.status === "importing")
			return { status: "importing", stage: "starting", progress: 0 };
		if (source.status === "complete") return { status: "imported" };
		return { status: "failed", error: source.error ?? undefined };
	}

	if (!source.videoExists) {
		return {
			status: "failed",
			error: source.error ?? LOOM_IMPORT_DELETED_VIDEO_ERROR,
		};
	}

	if (
		source.status === "complete" ||
		source.uploadPhase === null ||
		source.uploadPhase === "complete"
	) {
		return { status: "imported" };
	}

	if (source.uploadPhase === "error") {
		return {
			status: "failed",
			error:
				source.uploadError ?? source.error ?? "Loom import failed. Try again.",
		};
	}

	const progress = Math.max(0, Math.min(100, source.uploadProgress ?? 0));
	return {
		status: "importing",
		stage: importStage(source.uploadPhase, progress, source.uploadMessage),
		progress,
	};
}

export function emptyLoomImportCounts(): LoomImportCounts {
	return {
		checking: 0,
		ready: 0,
		queued: 0,
		importing: 0,
		imported: 0,
		failed: 0,
		skipped: 0,
		cancelled: 0,
		total: 0,
	};
}

export function countLoomImportItems(
	items: Iterable<{ status: LoomImportDisplayStatus }>,
): LoomImportCounts {
	const counts = emptyLoomImportCounts();
	for (const item of items) {
		counts[item.status]++;
		counts.total++;
	}
	return counts;
}

export function summarizeLoomImportItems(
	items: Iterable<Pick<LoomImportItemView, "status" | "duration" | "email">>,
): LoomImportSummaryView {
	const counts = emptyLoomImportCounts();
	const owners = new Set<string>();
	let totalDuration = 0;
	let importedDuration = 0;
	for (const item of items) {
		counts[item.status]++;
		counts.total++;
		if (item.email) owners.add(item.email);
		if (
			item.duration &&
			item.status !== "failed" &&
			item.status !== "cancelled"
		) {
			totalDuration += item.duration;
			if (item.status === "imported") importedDuration += item.duration;
		}
	}
	return {
		counts,
		totalDuration,
		importedDuration,
		owners: Math.max(owners.size, 1),
	};
}

export function loomImportProgress(
	counts: LoomImportCounts,
	importingProgress = 0,
) {
	const settled =
		counts.imported + counts.failed + counts.skipped + counts.cancelled;
	const total = counts.total;
	if (total === 0) return 0;
	return Math.min(1, (settled + importingProgress / 100) / total);
}

export function isLoomImportJobActive(status: LoomImportJobStatus) {
	return status === "checking" || status === "importing";
}

export function loomImportStageLabel(stage: LoomImportStage | undefined) {
	switch (stage) {
		case "starting":
			return "Starting";
		case "waiting":
			return "Waiting for a slot";
		case "downloading":
			return "Downloading from Loom";
		case "processing":
			return "Copying to Cap";
		case "finishing":
			return "Making previews";
		default:
			return "Importing";
	}
}
