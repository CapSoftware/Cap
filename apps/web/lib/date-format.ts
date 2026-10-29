import { fromNow } from "@/app/s/[videoId]/_components/utils/from-now";

// Replaces the dashboard's moment calls so moment and its locales stay out of
// the dashboard bundles. Parity with moment (en) is pinned by
// __tests__/unit/date-format.test.ts.

const INVALID_DATE = "Invalid date";

const MONTHS_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

const pad = (value: number, length: number) =>
	String(value).padStart(length, "0");

const isInvalid = (date: Date) => Number.isNaN(date.getTime());

export function formatDateTime(date: Date): string {
	if (isInvalid(date)) return INVALID_DATE;
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
}

export function formatMonthDayYear(date: Date): string {
	if (isInvalid(date)) return INVALID_DATE;
	return `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${pad(date.getFullYear(), 4)}`;
}

export function formatFromNow(date: Date, now?: Date): string {
	if (isInvalid(date)) return INVALID_DATE;
	return fromNow(date, now);
}

export function durationParts(seconds: number) {
	const milliseconds = +seconds * 1e3;
	return {
		asHours: milliseconds / 36e5,
		asMinutes: milliseconds / 6e4,
		asSeconds: milliseconds / 1e3,
	};
}

export function formatDuration(durationSecs: number): string {
	if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
		return "< 1 sec";
	}

	const safeSeconds = Math.max(0, Math.ceil(durationSecs));
	const totalHours = Math.floor(safeSeconds / 3600);
	const totalMinutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds % 60;

	if (totalHours > 0) {
		return `${totalHours} hr${totalHours > 1 ? "s" : ""}`;
	} else if (totalMinutes > 0) {
		return `${totalMinutes} min${totalMinutes > 1 ? "s" : ""}`;
	} else if (remainingSeconds > 0) {
		return `${remainingSeconds} sec${remainingSeconds !== 1 ? "s" : ""}`;
	} else {
		return "< 1 sec";
	}
}
