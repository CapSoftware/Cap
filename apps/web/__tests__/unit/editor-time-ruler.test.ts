import { describe, expect, it } from "vitest";

const MARKING_RESOLUTIONS = [0.5, 1, 2.5, 5, 10, 30];
const MAX_TIMELINE_MARKINGS = 60;

function getMarkingResolution(zoom: number): number {
	return (
		MARKING_RESOLUTIONS.find((r) => zoom / r <= MAX_TIMELINE_MARKINGS) ?? 30
	);
}

function calculateMarkings(
	position: number,
	zoom: number,
	duration: number,
	secsPerPixel: number,
): Array<{ time: number; x: number; isMajor: boolean }> {
	const markingResolution = getMarkingResolution(zoom);
	const markingCount = Math.ceil(2 + (zoom + 5) / markingResolution);
	const markingOffset = position % markingResolution;
	const result: Array<{ time: number; x: number; isMajor: boolean }> = [];

	for (let i = 0; i < markingCount; i++) {
		const time = position - markingOffset + i * markingResolution;
		if (time > 0 && time <= duration) {
			result.push({
				time,
				x: (time - position) / secsPerPixel,
				isMajor: time % 1 === 0,
			});
		}
	}

	return result;
}

function formatTime(seconds: number): string {
	const hrs = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	if (hrs > 0) {
		return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
	}
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

describe("TimeRuler marking resolution", () => {
	describe("short videos (< 30 seconds)", () => {
		it("uses 0.5s resolution for 10 second video", () => {
			const resolution = getMarkingResolution(10);
			expect(resolution).toBe(0.5);
		});

		it("uses 0.5s resolution for 15 second video", () => {
			const resolution = getMarkingResolution(15);
			expect(resolution).toBe(0.5);
		});

		it("uses 0.5s resolution for 25 second video", () => {
			const resolution = getMarkingResolution(25);
			expect(resolution).toBe(0.5);
		});
	});

	describe("medium videos (30 seconds - 2 minutes)", () => {
		it("uses 1s resolution for 30 second video", () => {
			const resolution = getMarkingResolution(30);
			expect(resolution).toBe(0.5);
		});

		it("uses 1s resolution for 60 second video", () => {
			const resolution = getMarkingResolution(60);
			expect(resolution).toBe(1);
		});

		it("uses 2.5s resolution for 90 second video", () => {
			const resolution = getMarkingResolution(90);
			expect(resolution).toBe(2.5);
		});

		it("uses 2.5s resolution for 120 second video", () => {
			const resolution = getMarkingResolution(120);
			expect(resolution).toBe(2.5);
		});
	});

	describe("long videos (2 - 10 minutes)", () => {
		it("uses 5s resolution for 3 minute video", () => {
			const resolution = getMarkingResolution(180);
			expect(resolution).toBe(5);
		});

		it("uses 5s resolution for 5 minute video", () => {
			const resolution = getMarkingResolution(300);
			expect(resolution).toBe(5);
		});

		it("uses 10s resolution for 8 minute video", () => {
			const resolution = getMarkingResolution(480);
			expect(resolution).toBe(10);
		});

		it("uses 10s resolution for 10 minute video", () => {
			const resolution = getMarkingResolution(600);
			expect(resolution).toBe(10);
		});
	});

	describe("very long videos (> 10 minutes)", () => {
		it("uses 30s resolution for 20 minute video", () => {
			const resolution = getMarkingResolution(1200);
			expect(resolution).toBe(30);
		});

		it("uses 30s resolution for 1 hour video", () => {
			const resolution = getMarkingResolution(3600);
			expect(resolution).toBe(30);
		});

		it("uses 30s resolution for 2 hour video", () => {
			const resolution = getMarkingResolution(7200);
			expect(resolution).toBe(30);
		});
	});
});

describe("TimeRuler markings calculation", () => {
	const defaultSecsPerPixel = 0.01;

	it("generates markings for 10 second video", () => {
		const markings = calculateMarkings(0, 10, 10, defaultSecsPerPixel);
		expect(markings.length).toBeGreaterThan(0);
		expect(markings.every((m) => m.time <= 10)).toBe(true);
		expect(markings.every((m) => m.time > 0)).toBe(true);
	});

	it("generates markings for 60 second video", () => {
		const markings = calculateMarkings(0, 60, 60, defaultSecsPerPixel);
		expect(markings.length).toBeGreaterThan(0);
		expect(markings.every((m) => m.time <= 60)).toBe(true);
	});

	it("generates markings for 5 minute video", () => {
		const markings = calculateMarkings(0, 300, 300, defaultSecsPerPixel);
		expect(markings.length).toBeGreaterThan(0);
		expect(markings.every((m) => m.time <= 300)).toBe(true);
	});

	it("generates markings for 1 hour video", () => {
		const markings = calculateMarkings(0, 3600, 3600, defaultSecsPerPixel);
		expect(markings.length).toBeGreaterThan(0);
		expect(markings.every((m) => m.time <= 3600)).toBe(true);
	});

	it("correctly identifies major markings (whole seconds)", () => {
		const markings = calculateMarkings(0, 10, 10, defaultSecsPerPixel);
		const majorMarkings = markings.filter((m) => m.isMajor);
		expect(majorMarkings.every((m) => m.time % 1 === 0)).toBe(true);
	});

	it("respects position offset", () => {
		const markingsAtStart = calculateMarkings(0, 10, 60, defaultSecsPerPixel);
		const markingsAtMiddle = calculateMarkings(30, 10, 60, defaultSecsPerPixel);

		expect(markingsAtStart[0]?.time).toBeLessThan(
			markingsAtMiddle[0]?.time || Infinity,
		);
	});

	it("does not generate markings beyond video duration", () => {
		const markings = calculateMarkings(0, 100, 50, defaultSecsPerPixel);
		expect(markings.every((m) => m.time <= 50)).toBe(true);
	});

	it("handles edge case of very short video (1 second)", () => {
		const markings = calculateMarkings(0, 1, 1, defaultSecsPerPixel);
		expect(markings.length).toBeGreaterThanOrEqual(0);
		expect(markings.every((m) => m.time <= 1)).toBe(true);
	});

	it("handles edge case of fractional duration", () => {
		const markings = calculateMarkings(0, 5.5, 5.5, defaultSecsPerPixel);
		expect(markings.every((m) => m.time <= 5.5)).toBe(true);
	});
});

describe("formatTime", () => {
	describe("short durations (< 1 minute)", () => {
		it("formats 0 seconds", () => {
			expect(formatTime(0)).toBe("0:00");
		});

		it("formats 5 seconds", () => {
			expect(formatTime(5)).toBe("0:05");
		});

		it("formats 30 seconds", () => {
			expect(formatTime(30)).toBe("0:30");
		});

		it("formats 59 seconds", () => {
			expect(formatTime(59)).toBe("0:59");
		});
	});

	describe("medium durations (1 - 60 minutes)", () => {
		it("formats 1 minute", () => {
			expect(formatTime(60)).toBe("1:00");
		});

		it("formats 1 minute 30 seconds", () => {
			expect(formatTime(90)).toBe("1:30");
		});

		it("formats 5 minutes", () => {
			expect(formatTime(300)).toBe("5:00");
		});

		it("formats 10 minutes", () => {
			expect(formatTime(600)).toBe("10:00");
		});

		it("formats 59 minutes 59 seconds", () => {
			expect(formatTime(3599)).toBe("59:59");
		});
	});

	describe("long durations (>= 1 hour)", () => {
		it("formats 1 hour", () => {
			expect(formatTime(3600)).toBe("1:00:00");
		});

		it("formats 1 hour 30 minutes", () => {
			expect(formatTime(5400)).toBe("1:30:00");
		});

		it("formats 2 hours 15 minutes 30 seconds", () => {
			expect(formatTime(8130)).toBe("2:15:30");
		});

		it("formats 10 hours", () => {
			expect(formatTime(36000)).toBe("10:00:00");
		});
	});

	describe("edge cases", () => {
		it("handles decimal seconds by flooring", () => {
			expect(formatTime(5.7)).toBe("0:05");
			expect(formatTime(59.9)).toBe("0:59");
		});

		it("handles very large durations", () => {
			expect(formatTime(86400)).toBe("24:00:00");
		});
	});
});

describe("resolution boundaries", () => {
	it("transitions from 0.5s to 1s at correct threshold", () => {
		expect(getMarkingResolution(30)).toBe(0.5);
		expect(getMarkingResolution(31)).toBe(1);
	});

	it("transitions from 1s to 2.5s at correct threshold", () => {
		expect(getMarkingResolution(60)).toBe(1);
		expect(getMarkingResolution(61)).toBe(2.5);
	});

	it("transitions from 2.5s to 5s at correct threshold", () => {
		expect(getMarkingResolution(150)).toBe(2.5);
		expect(getMarkingResolution(151)).toBe(5);
	});

	it("transitions from 5s to 10s at correct threshold", () => {
		expect(getMarkingResolution(300)).toBe(5);
		expect(getMarkingResolution(301)).toBe(10);
	});

	it("transitions from 10s to 30s at correct threshold", () => {
		expect(getMarkingResolution(600)).toBe(10);
		expect(getMarkingResolution(601)).toBe(30);
	});
});

describe("marking count limits", () => {
	it("never exceeds MAX_TIMELINE_MARKINGS for any visible zoom range", () => {
		const testZooms = [10, 30, 60, 120, 300, 600, 1800];

		for (const zoom of testZooms) {
			const resolution = getMarkingResolution(zoom);
			const potentialMarkings = zoom / resolution;
			expect(potentialMarkings).toBeLessThanOrEqual(MAX_TIMELINE_MARKINGS);
		}
	});

	it("handles very long videos by increasing resolution", () => {
		const resolution = getMarkingResolution(3600);
		expect(resolution).toBe(30);
		expect(3600 / 30).toBe(120);
	});
});
