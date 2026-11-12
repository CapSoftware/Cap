import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";

export type InfraStorageSnapshot = {
	snapshotDate: string;
	totalDurationMinutes: number;
	videoCount: number;
	microCreditsCharged: number;
};

export function utcMonthStart(now: Date) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function utcDateKey(date: Date) {
	return date.toISOString().slice(0, 10);
}

export function utcDaysAgoKey(now: Date, days: number) {
	return utcDateKey(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
}

export function summarizeStorageMonth(
	snapshots: readonly InfraStorageSnapshot[],
	now: Date,
) {
	const monthPrefix = utcDateKey(utcMonthStart(now)).slice(0, 7);
	let chargedMicroCredits = 0;
	let billedDays = 0;
	for (const snapshot of snapshots) {
		if (!snapshot.snapshotDate.startsWith(monthPrefix)) continue;
		chargedMicroCredits += Number(snapshot.microCreditsCharged) || 0;
		billedDays += 1;
	}
	return { chargedMicroCredits, billedDays };
}

export function formatCredits(microCredits: number) {
	const dollars = (Number(microCredits) || 0) / MICRO_CREDITS_PER_DOLLAR;
	return `$${dollars.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export function formatCharge(microCredits: number) {
	const dollars =
		Math.abs(Number(microCredits) || 0) / MICRO_CREDITS_PER_DOLLAR;
	if (dollars > 0 && dollars < 0.01) {
		return `$${dollars.toFixed(4)}`;
	}
	return `$${dollars.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export function formatMinutes(minutes: number) {
	const value = Number(minutes) || 0;
	return value.toLocaleString("en-US", {
		maximumFractionDigits: value < 10 ? 1 : 0,
	});
}

export function formatDuration(seconds: number | null | undefined) {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
		return null;
	}
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return hours > 0
		? `${hours}:${pad(mins)}:${pad(secs)}`
		: `${mins}:${pad(secs)}`;
}
