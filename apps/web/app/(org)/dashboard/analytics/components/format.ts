export type Granularity = "hour" | "day" | "week";

export const granularityOf = (
	buckets: ReadonlyArray<{ bucket: string }>,
): Granularity => {
	const first = buckets[0];
	const second = buckets[1];
	if (!first || !second) return "day";
	const gap =
		new Date(second.bucket).getTime() - new Date(first.bucket).getTime();
	return gap > 0 && gap <= 60 * 60 * 1000 ? "hour" : "day";
};

export const formatCompact = (value: number) => {
	if (value >= 1_000_000)
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return value.toLocaleString();
};

export const formatPercent = (fraction: number) => {
	const pct = fraction * 100;
	if (pct > 0 && pct < 1) return "<1%";
	return `${Math.round(pct)}%`;
};

export const formatBucketTick = (
	bucket: string,
	granularity: Granularity,
	spanDays: number,
) => {
	const date = new Date(bucket);
	if (Number.isNaN(date.getTime())) return bucket;
	if (granularity === "hour") {
		return date.toLocaleTimeString([], { hour: "numeric" });
	}
	if (spanDays > 300) {
		return date.toLocaleDateString([], {
			month: "short",
			year: "numeric",
			timeZone: "UTC",
		});
	}
	return date.toLocaleDateString([], {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});
};

export const formatBucketTitle = (
	bucket: string,
	granularity: Granularity,
	bucketEnd?: string,
	now = Date.now(),
) => {
	const date = new Date(bucket);
	if (Number.isNaN(date.getTime())) return bucket;
	const thisYear = new Date(now).getUTCFullYear();
	if (granularity === "hour") {
		const day = date.toLocaleDateString([], {
			weekday: "short",
			day: "numeric",
			month: "short",
		});
		const start = date.toLocaleTimeString([], { hour: "numeric" });
		const end = new Date(date.getTime() + 60 * 60 * 1000).toLocaleTimeString(
			[],
			{ hour: "numeric" },
		);
		return `${day}, ${start} to ${end}`;
	}
	if (granularity === "week") {
		const end = bucketEnd
			? new Date(bucketEnd)
			: new Date(date.getTime() + 6 * 24 * 60 * 60 * 1000);
		const showYear =
			date.getUTCFullYear() !== thisYear || end.getUTCFullYear() !== thisYear;
		const short = (d: Date) =>
			d.toLocaleDateString([], {
				day: "numeric",
				month: "short",
				year: showYear ? "numeric" : undefined,
				timeZone: "UTC",
			});
		return `${short(date)} to ${short(end)}`;
	}
	return date.toLocaleDateString([], {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: date.getUTCFullYear() !== thisYear ? "numeric" : undefined,
		timeZone: "UTC",
	});
};

export const formatRelative = (
	bucket: string,
	granularity: Granularity,
	now = Date.now(),
) => {
	const date = new Date(bucket);
	if (Number.isNaN(date.getTime())) return "";
	if (granularity === "hour") {
		const hours = Math.floor((now - date.getTime()) / (60 * 60 * 1000));
		if (hours <= 0) return "This hour";
		if (hours === 1) return "1 hour ago";
		return `${hours} hours ago`;
	}
	const today = new Date(now);
	const todayUtc = Date.UTC(
		today.getUTCFullYear(),
		today.getUTCMonth(),
		today.getUTCDate(),
	);
	const days = Math.round((todayUtc - date.getTime()) / (24 * 60 * 60 * 1000));
	if (granularity === "week") {
		const weeks = Math.floor(days / 7);
		if (weeks <= 0) return "This week";
		if (weeks === 1) return "Last week";
		if (weeks < 9) return `${weeks} weeks ago`;
	}
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 60) return `${days} days ago`;
	const months = Math.round(days / 30.4);
	if (months < 24) return `${months} months ago`;
	return `${Math.floor(days / 365)} years ago`;
};

const regionNames =
	typeof Intl !== "undefined" && "DisplayNames" in Intl
		? new Intl.DisplayNames(["en"], { type: "region" })
		: null;

export const countryName = (code: string) => {
	const trimmed = code.trim();
	if (!/^[A-Za-z]{2}$/.test(trimmed)) return trimmed;
	try {
		return regionNames?.of(trimmed.toUpperCase()) ?? trimmed;
	} catch {
		return trimmed;
	}
};
