import type { MobileCapSummary } from "@/api/mobile";
import { formatDuration, formatRelativeDate } from "../utils/format";

const clampPercent = (value: number) => {
	const safeValue = Number.isFinite(value) ? value : 0;
	return Math.min(100, Math.max(0, Math.round(safeValue)));
};

const getUploadProgress = (cap: MobileCapSummary) => {
	if (!cap.upload) return null;

	if (cap.upload.phase === "uploading") {
		return clampPercent(
			(cap.upload.total > 0 ? cap.upload.uploaded / cap.upload.total : 0) * 100,
		);
	}

	return clampPercent(cap.upload.processingProgress);
};

const getUploadStatusText = (cap: MobileCapSummary) => {
	if (!cap.upload) return null;

	switch (cap.upload.phase) {
		case "processing":
			return cap.upload.processingMessage ?? "Processing";
		case "generating_thumbnail":
			return cap.upload.processingMessage ?? "Finishing up";
		case "complete":
			return cap.upload.processingMessage ?? "Finishing up";
		case "error":
			return cap.upload.processingError ?? "Upload failed";
		default:
			return `${getUploadProgress(cap) ?? 0}% uploaded`;
	}
};

export const getCapCardViewModel = (
	cap: MobileCapSummary,
	now = new Date(),
) => {
	const duration = formatDuration(cap.durationSeconds);
	const date = formatRelativeDate(cap.createdAt, now);
	const visibility = cap.public ? "Shared" : "Not shared";
	const uploadStatusText = getUploadStatusText(cap);
	const uploadProgress = getUploadProgress(cap);
	const uploadFailed = cap.upload?.phase === "error";

	return {
		date,
		duration,
		visibility,
		uploadStatusText,
		uploadProgress,
		uploadFailed,
		accessibilityLabel: [cap.title, date, visibility, uploadStatusText]
			.filter(Boolean)
			.join(", "),
	};
};
