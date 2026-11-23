import { describe, expect, it } from "vitest";
import { formatDuration } from "@/components/VideoThumbnail";

describe("VideoThumbnail formatDuration", () => {
	it("rolls fractional seconds just under a minute over to 1 min", () => {
		expect(formatDuration(59)).toBe("59 secs");
		expect(formatDuration(59.2)).toBe("1 min");
		expect(formatDuration(59.5)).toBe("1 min");
		expect(formatDuration(59.99)).toBe("1 min");
		expect(formatDuration(60)).toBe("1 min");
	});

	it("rolls fractional seconds just under an hour over to 1 hr", () => {
		expect(formatDuration(3599)).toBe("59 mins");
		expect(formatDuration(3599.5)).toBe("1 hr");
	});

	it("keeps short durations readable", () => {
		expect(formatDuration(0)).toBe("< 1 sec");
		expect(formatDuration(0.2)).toBe("1 sec");
		expect(formatDuration(1)).toBe("1 sec");
		expect(formatDuration(30.4)).toBe("31 secs");
	});

	it("keeps whole minutes and hours unchanged", () => {
		expect(formatDuration(90)).toBe("1 min");
		expect(formatDuration(150)).toBe("2 mins");
		expect(formatDuration(7200)).toBe("2 hrs");
	});
});
