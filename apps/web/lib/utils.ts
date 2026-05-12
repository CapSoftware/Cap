import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Format a date string to a more readable format
 * @param dateString - ISO 8601 date string
 * @returns Formatted date string (e.g., October 1, 2024)
 */
export function formatDate(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

const ordinalSuffix = (day: number) => {
	const remainder = day % 100;
	if (remainder >= 11 && remainder <= 13) return "th";
	if (day % 10 === 1) return "st";
	if (day % 10 === 2) return "nd";
	if (day % 10 === 3) return "rd";
	return "th";
};

export function formatUtcMonthDayOrdinal(dateString: string): string {
	const date = new Date(dateString);
	const month = date.toLocaleDateString("en-US", {
		month: "long",
		timeZone: "UTC",
	});
	const day = date.getUTCDate();
	return `${month} ${day}${ordinalSuffix(day)}`;
}

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
