import {
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	type InfraResolutionTier,
	infraResolutionTier,
} from "@/lib/infra-pricing";

export const MICRO_CREDITS_PER_DOLLAR = 100_000;
export const STORAGE_BILLING_DAYS_PER_MONTH = 30;
export const UPLOAD_ADMISSION_DAYS = 7;
export const SPEECH_DOLLARS_PER_HOUR = INFRA_SPEECH_DOLLARS_PER_HOUR;

export type BillableVideo = {
	durationSeconds: number;
	width: number;
	height: number;
	tier: InfraResolutionTier;
};

export type StorageMinutesByTier = Record<InfraResolutionTier, number>;
export const SPEECH_MICRO_CREDITS_PER_HOUR = Math.round(
	SPEECH_DOLLARS_PER_HOUR * MICRO_CREDITS_PER_DOLLAR,
);

export type StorageUsage = {
	videoCount: number;
	totalMinutes: number;
	minutesByTier: StorageMinutesByTier;
	monthlyMicroCredits: number;
	dailyMicroCredits: number;
};

const positive = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const isTier = (value: unknown): value is InfraResolutionTier =>
	INFRA_RESOLUTION_TIERS.some((tier) => tier === value);

export function videoStorageTier(
	video: { width: number; height: number },
	maxTier?: InfraResolutionTier | null,
): InfraResolutionTier {
	const sourceTier = infraResolutionTier(video.width, video.height);
	if (!maxTier) return sourceTier;
	return INFRA_RESOLUTION_TIERS.indexOf(maxTier) <
		INFRA_RESOLUTION_TIERS.indexOf(sourceTier)
		? maxTier
		: sourceTier;
}

export type BillableVideoRow = {
	duration: number | null | undefined;
	width: number | null | undefined;
	height: number | null | undefined;
	maxResolutionTier: string | null | undefined;
	status?: string | null;
	includeProcessing?: boolean;
};

export function billableVideo(video: BillableVideoRow): BillableVideo | null {
	if (
		video.status !== undefined &&
		video.status !== "ready" &&
		!(video.includeProcessing && video.status === "processing")
	) {
		return null;
	}
	const durationSeconds = positive(video.duration);
	if (durationSeconds <= 0) return null;
	const width = positive(video.width);
	const height = positive(video.height);
	return {
		durationSeconds,
		width,
		height,
		tier: videoStorageTier(
			{ width, height },
			isTier(video.maxResolutionTier) ? video.maxResolutionTier : null,
		),
	};
}

export function storageMicroCreditsPerMinutePerMonth(
	tier: InfraResolutionTier,
) {
	return Math.round(
		(INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier] *
			MICRO_CREDITS_PER_DOLLAR) /
			1000,
	);
}

export function emptyStorageMinutes(): StorageMinutesByTier {
	return { "1080p": 0, "1440p": 0, "2160p": 0 };
}

export function monthlyStorageMicroCredits(
	minutesByTier: StorageMinutesByTier,
) {
	let total = 0;
	for (const tier of INFRA_RESOLUTION_TIERS) {
		total +=
			positive(minutesByTier[tier]) *
			storageMicroCreditsPerMinutePerMonth(tier);
	}
	return total;
}

export function dailyStorageMicroCredits(minutesByTier: StorageMinutesByTier) {
	return Math.floor(
		monthlyStorageMicroCredits(minutesByTier) / STORAGE_BILLING_DAYS_PER_MONTH,
	);
}

export function storageUsage(
	videos: readonly { video: BillableVideo | null; count: number }[],
): StorageUsage {
	const minutesByTier = emptyStorageMinutes();
	let videoCount = 0;
	let totalMinutes = 0;
	for (const entry of videos) {
		if (!entry.video) continue;
		const minutes = entry.video.durationSeconds / 60;
		minutesByTier[entry.video.tier] += minutes;
		totalMinutes += minutes;
		videoCount += positive(entry.count);
	}
	return {
		videoCount,
		totalMinutes,
		minutesByTier,
		monthlyMicroCredits: monthlyStorageMicroCredits(minutesByTier),
		dailyMicroCredits: dailyStorageMicroCredits(minutesByTier),
	};
}

export function uploadAdmissionMicroCredits(monthlyMicroCredits: number) {
	return Math.max(
		1,
		Math.ceil(
			(positive(monthlyMicroCredits) * UPLOAD_ADMISSION_DAYS) /
				STORAGE_BILLING_DAYS_PER_MONTH,
		),
	);
}

export function transcriptionBilledSeconds(durationSeconds: number) {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
	return Math.max(1, Math.round(durationSeconds));
}

export function transcriptionMicroCredits(durationSeconds: number) {
	const billedSeconds = transcriptionBilledSeconds(durationSeconds);
	if (billedSeconds === 0) return 0;
	return Math.max(
		1,
		Math.floor((billedSeconds * SPEECH_MICRO_CREDITS_PER_HOUR) / 3600),
	);
}
