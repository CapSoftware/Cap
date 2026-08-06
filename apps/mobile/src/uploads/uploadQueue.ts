import type { MobileCapSummary } from "@/api/mobile";

export type UploadQueueStatus =
	| "queued"
	| "uploading"
	| "processing"
	| "failed"
	| "complete";

export type UploadQueueItem = {
	id: string;
	localUri: string;
	fileName: string;
	contentType: string;
	size: number;
	durationSeconds?: number;
	width?: number;
	height?: number;
	folderId: string | null;
	organizationId: string | null;
	status: UploadQueueStatus;
	progress: number;
	error: string | null;
	capId: string | null;
	rawFileKey: string | null;
	processingMessage: string | null;
	createdAt: string;
	updatedAt: string;
};

export type UploadQueueAction =
	| { type: "enqueue"; item: Omit<UploadQueueItem, "createdAt" | "updatedAt"> }
	| { type: "start"; id: string; capId: string; rawFileKey: string }
	| { type: "progress"; id: string; progress: number }
	| {
			type: "processing";
			id: string;
			progress?: number;
			message?: string | null;
	  }
	| { type: "complete"; id: string }
	| { type: "fail"; id: string; error: string }
	| { type: "remove"; id: string }
	| { type: "retry"; id: string };

export type UploadQueueState = {
	items: UploadQueueItem[];
};

const clampProgress = (progress: number) => {
	if (!Number.isFinite(progress)) return 0;
	return Math.min(1, Math.max(0, progress));
};

export const uploadProgressPercent = (progress: number) =>
	Math.round(clampProgress(progress) * 100);

export const isTerminalUploadQueueAction = (action: UploadQueueAction) =>
	action.type === "complete" || action.type === "fail";

export const uploadQueueStatusText = (item: UploadQueueItem) => {
	switch (item.status) {
		case "queued":
			return "Queued";
		case "uploading":
			return `Uploading ${uploadProgressPercent(item.progress)}%`;
		case "processing":
			return item.processingMessage ?? "Finishing up";
		case "complete":
			return "Ready to view";
		case "failed":
			return "Upload failed";
	}
};

export const uploadQueueActionFromCapUpload = (
	id: string,
	upload: MobileCapSummary["upload"],
): UploadQueueAction | null => {
	if (!upload || upload.phase === "complete") return { type: "complete", id };
	if (upload.phase === "error") {
		return {
			type: "fail",
			id,
			error: upload.processingError ?? "Processing failed",
		};
	}
	if (upload.phase === "uploading") {
		return {
			type: "progress",
			id,
			progress: upload.total > 0 ? upload.uploaded / upload.total : 0,
		};
	}
	return {
		type: "processing",
		id,
		progress: upload.processingProgress / 100,
		message:
			upload.processingMessage ??
			(upload.phase === "processing" ? "Processing" : "Finishing up"),
	};
};

const nowIso = () => new Date().toISOString();

const updateItem = (
	state: UploadQueueState,
	id: string,
	update: (item: UploadQueueItem) => UploadQueueItem,
): UploadQueueState => ({
	items: state.items.map((item) => (item.id === id ? update(item) : item)),
});

export const emptyUploadQueue: UploadQueueState = {
	items: [],
};

export const uploadQueueReducer = (
	state: UploadQueueState,
	action: UploadQueueAction,
): UploadQueueState => {
	const updatedAt = nowIso();

	switch (action.type) {
		case "enqueue":
			return {
				items: [
					...state.items,
					{
						...action.item,
						createdAt: updatedAt,
						updatedAt,
					},
				],
			};
		case "start":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "uploading",
				progress: 0,
				error: null,
				capId: action.capId,
				rawFileKey: action.rawFileKey,
				processingMessage: null,
				updatedAt,
			}));
		case "progress":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "uploading",
				progress: clampProgress(action.progress),
				error: null,
				processingMessage: null,
				updatedAt,
			}));
		case "processing":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "processing",
				progress:
					action.progress !== undefined
						? clampProgress(action.progress)
						: item.progress,
				processingMessage: action.message ?? null,
				updatedAt,
			}));
		case "complete":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "complete",
				progress: 1,
				error: null,
				processingMessage: null,
				updatedAt,
			}));
		case "fail":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "failed",
				error: action.error,
				processingMessage: null,
				updatedAt,
			}));
		case "remove":
			return {
				items: state.items.filter((item) => item.id !== action.id),
			};
		case "retry":
			return updateItem(state, action.id, (item) => ({
				...item,
				status: "queued",
				progress: 0,
				error: null,
				capId: null,
				rawFileKey: null,
				processingMessage: null,
				updatedAt,
			}));
	}
};
