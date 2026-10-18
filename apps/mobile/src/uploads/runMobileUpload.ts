import type { MobileApiClient, UploadFile } from "@/api/mobile";
import { uploadToTarget } from "@/api/mobile";

type RunMobileUploadInput = {
	client: MobileApiClient;
	file: UploadFile;
	organizationId?: string | null;
	folderId?: string | null;
	onCreated?: (capId: string, rawFileKey: string) => void;
	onProgress?: (progress: number) => void;
};

const uploadProgressSyncIntervalMs = 1000;
const uploadProgressSyncMinDelta = 0.05;
const uploadProgressUiIntervalMs = 100;
const uploadProgressUiMinPercentDelta = 2;

const nonNegativeFiniteNumber = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const positiveFiniteNumber = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;

const clampProgress = (progress: number) => {
	const safeProgress = Number.isFinite(progress) ? progress : 0;
	return Math.min(1, Math.max(0, safeProgress));
};

const shouldSyncUploadProgress = (
	progress: number,
	now: number,
	lastSyncedProgress: number | null,
	lastSyncedAt: number,
) =>
	lastSyncedProgress === null ||
	progress >= 1 ||
	progress - lastSyncedProgress >= uploadProgressSyncMinDelta ||
	now - lastSyncedAt >= uploadProgressSyncIntervalMs;

export const runMobileUpload = async ({
	client,
	file,
	organizationId,
	folderId,
	onCreated,
	onProgress,
}: RunMobileUploadInput) => {
	const created = await client.createUpload({
		organizationId: organizationId ?? undefined,
		folderId: folderId ?? undefined,
		fileName: file.name,
		contentType: file.type,
		contentLength: file.size,
		durationSeconds: file.durationSeconds,
		width: file.width,
		height: file.height,
	});
	onCreated?.(created.id, created.rawFileKey);

	let lastSyncedProgress: number | null = null;
	let lastSyncedAt = 0;
	let lastUiPercent = -1;
	let lastUiAt = 0;
	let pendingProgress: { uploaded: number; total: number } | null = null;
	let progressSync: Promise<void> | null = null;
	const syncProgress = async (initial: { uploaded: number; total: number }) => {
		let next: { uploaded: number; total: number } | null = initial;
		while (next) {
			try {
				await client.updateUploadProgress(created.id, next);
			} catch {}
			next = pendingProgress;
			pendingProgress = null;
		}
		progressSync = null;
	};
	const enqueueProgressSync = (progress: {
		uploaded: number;
		total: number;
	}) => {
		if (progressSync) {
			pendingProgress = progress;
			return;
		}
		progressSync = syncProgress(progress);
	};

	await uploadToTarget(created.upload, file, ({ loaded, total }) => {
		const safeLoaded = nonNegativeFiniteNumber(loaded);
		const safeTotal =
			positiveFiniteNumber(total) ??
			positiveFiniteNumber(file.size) ??
			safeLoaded;
		const progress = safeTotal > 0 ? safeLoaded / safeTotal : 0;
		const clampedProgress = clampProgress(progress);
		const now = Date.now();
		const uiPercent = Math.floor(clampedProgress * 100);
		if (
			lastUiPercent < 0 ||
			uiPercent >= 100 ||
			uiPercent - lastUiPercent >= uploadProgressUiMinPercentDelta ||
			now - lastUiAt >= uploadProgressUiIntervalMs
		) {
			lastUiPercent = uiPercent;
			lastUiAt = now;
			onProgress?.(clampedProgress);
		}
		if (
			shouldSyncUploadProgress(
				clampedProgress,
				now,
				lastSyncedProgress,
				lastSyncedAt,
			)
		) {
			lastSyncedProgress = clampedProgress;
			lastSyncedAt = now;
			enqueueProgressSync({ uploaded: safeLoaded, total: safeTotal });
		}
	});
	await progressSync;

	await client.completeUpload(created.id, {
		rawFileKey: created.rawFileKey,
		contentLength: file.size,
	});

	return created;
};
