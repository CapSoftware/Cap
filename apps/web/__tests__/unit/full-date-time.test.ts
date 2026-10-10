import { describe, expect, it } from "vitest";
import { formatFullDateTime } from "@/app/s/[videoId]/_components/utils/full-date-time";

const moment = new Date("2026-10-06T13:32:00Z");

describe("formatFullDateTime", () => {
	it("spells out the weekday, date and time in the viewer's locale", () => {
		const text = formatFullDateTime(moment, "en-GB", "Europe/London");
		expect(text).toContain("Tuesday");
		expect(text).toContain("6 October 2026");
		expect(text).toContain("14:32");
	});

	it("uses the viewer's timezone, not UTC", () => {
		expect(formatFullDateTime(moment, "en-GB", "Asia/Singapore")).toContain(
			"21:32",
		);
		expect(formatFullDateTime(moment, "en-US", "America/New_York")).toMatch(
			/Tuesday, October 6, 2026.*9:32\sAM/,
		);
	});
});
