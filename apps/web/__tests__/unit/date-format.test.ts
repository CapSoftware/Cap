import moment from "moment";
import { describe, expect, it } from "vitest";
import {
	durationParts,
	formatDateTime,
	formatFromNow,
	formatMonthDayYear,
} from "../../lib/date-format";

// moment is the oracle: every helper must match the moment call it replaced.
const sampleDates = (() => {
	const dates: Date[] = [
		new Date(2026, 0, 1, 0, 0, 0),
		new Date(2026, 11, 31, 23, 59, 59, 999),
		new Date(2024, 1, 29, 12, 30, 5),
		new Date(1999, 8, 9, 9, 9, 9),
		new Date(2026, 2, 29, 1, 30, 0),
		new Date(2026, 9, 25, 2, 30, 0),
		new Date(0),
	];
	let seed = 7;
	const random = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	const start = new Date(2015, 0, 1).getTime();
	const end = new Date(2030, 0, 1).getTime();
	for (let i = 0; i < 2000; i++) {
		dates.push(new Date(start + Math.floor(random() * (end - start))));
	}
	return dates;
})();

describe("formatDateTime", () => {
	it("matches moment format YYYY-MM-DD HH:mm:ss", () => {
		for (const date of sampleDates) {
			expect(formatDateTime(date)).toBe(
				moment(date).format("YYYY-MM-DD HH:mm:ss"),
			);
		}
	});

	it("matches moment for an invalid date", () => {
		const invalid = new Date("not a date");
		expect(formatDateTime(invalid)).toBe(
			moment(invalid).format("YYYY-MM-DD HH:mm:ss"),
		);
	});
});

describe("formatMonthDayYear", () => {
	it("matches moment format MMM D, YYYY", () => {
		for (const date of sampleDates) {
			expect(formatMonthDayYear(date)).toBe(moment(date).format("MMM D, YYYY"));
		}
	});

	it("matches moment for an invalid date", () => {
		const invalid = new Date("not a date");
		expect(formatMonthDayYear(invalid)).toBe(
			moment(invalid).format("MMM D, YYYY"),
		);
	});
});

describe("formatFromNow", () => {
	it("matches moment fromNow", () => {
		const now = new Date(2026, 9, 28, 12, 0, 0);
		for (const date of sampleDates) {
			expect(formatFromNow(date, now)).toBe(moment(date).from(moment(now)));
		}
	});

	it("matches moment for an invalid date", () => {
		const invalid = new Date("not a date");
		expect(formatFromNow(invalid)).toBe(moment(invalid).fromNow());
	});

	it("matches moment for dates that arrive as JSON strings", () => {
		const now = new Date(2026, 9, 28, 12, 0, 0);
		for (const date of sampleDates) {
			const json = JSON.parse(JSON.stringify({ date })).date as string;
			expect(formatFromNow(new Date(json), now)).toBe(
				moment(json).from(moment(now)),
			);
		}
	});
});

describe("durationParts", () => {
	it("matches moment.duration(seconds, 'seconds') conversions", () => {
		const values = [
			0,
			0.001,
			0.4,
			0.5,
			0.999,
			1,
			1.5,
			29.97,
			59,
			59.4,
			59.5,
			59.999,
			60,
			60.001,
			61,
			89.9,
			119.5,
			599.6,
			3599,
			3599.5,
			3600,
			3600.1,
			3601,
			7199.99,
			7200,
			86399.9,
			86400,
			172800.5,
			123456.789,
			0.1 + 0.2,
		];
		for (let s = 0; s < 20000; s += 0.37) values.push(s);
		for (const seconds of values) {
			const expected = moment.duration(seconds, "seconds");
			const actual = durationParts(seconds);
			expect(actual.asHours).toBe(expected.asHours());
			expect(actual.asMinutes).toBe(expected.asMinutes());
			expect(actual.asSeconds).toBe(expected.asSeconds());
		}
	});
});
