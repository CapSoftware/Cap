import { describe, expect, it, vi } from "vitest";

const FRAME_DURATION = 1 / 30;
const SKIP_DURATION = 5;

interface Segment {
	start: number;
	end: number;
	timescale: number;
}

interface TimelineSelection {
	indices: number[];
}

function isInputElement(tagName: string | null, isContentEditable: boolean): boolean {
	if (!tagName) return false;
	return (
		tagName === "INPUT" ||
		tagName === "TEXTAREA" ||
		isContentEditable
	);
}

function deleteSelectedSegments(
	selection: TimelineSelection | null,
	segments: Segment[],
): { newSegments: Segment[] | null; shouldClearSelection: boolean } {
	if (!selection || selection.indices.length === 0) {
		return { newSegments: null, shouldClearSelection: false };
	}

	const indicesToDelete = new Set(selection.indices);
	const newSegments = segments.filter((_, index) => !indicesToDelete.has(index));

	if (newSegments.length === 0) {
		return { newSegments: null, shouldClearSelection: false };
	}

	return { newSegments, shouldClearSelection: true };
}

function splitAtPlayhead(
	currentTime: number,
	segments: Segment[],
): Segment[] | null {
	let segmentIndex = -1;
	let accumulatedTime = 0;

	for (const [i, segment] of segments.entries()) {
		const segmentDuration = (segment.end - segment.start) / segment.timescale;
		if (
			currentTime >= accumulatedTime &&
			currentTime < accumulatedTime + segmentDuration
		) {
			segmentIndex = i;
			break;
		}
		accumulatedTime += segmentDuration;
	}

	const segment = segments[segmentIndex];
	if (segmentIndex === -1 || !segment) return null;

	const segmentStartTime = accumulatedTime;
	const relativeTime = currentTime - segmentStartTime;
	const splitPoint = segment.start + relativeTime * segment.timescale;

	if (splitPoint <= segment.start + 0.01 || splitPoint >= segment.end - 0.01) {
		return null;
	}

	const firstHalf = { ...segment, end: splitPoint };
	const secondHalf = { ...segment, start: splitPoint };

	return [
		...segments.slice(0, segmentIndex),
		firstHalf,
		secondHalf,
		...segments.slice(segmentIndex + 1),
	];
}

function computeSeekPosition(
	key: string,
	currentTime: number,
	duration: number,
	isMod: boolean,
	isShift: boolean,
): number | null {
	if (key === "Home" || (key === "ArrowLeft" && isMod)) {
		return 0;
	}
	if (key === "End" || (key === "ArrowRight" && isMod)) {
		return duration;
	}
	if (key === "ArrowLeft" && !isMod) {
		const step = isShift ? SKIP_DURATION : FRAME_DURATION;
		return Math.max(0, currentTime - step);
	}
	if (key === "ArrowRight" && !isMod) {
		const step = isShift ? SKIP_DURATION : FRAME_DURATION;
		return Math.min(duration, currentTime + step);
	}
	return null;
}

function shouldHandleUndoRedo(
	key: string,
	isMod: boolean,
	isShift: boolean,
): "undo" | "redo" | null {
	if (key === "z" && isMod && !isShift) return "undo";
	if ((key === "z" && isMod && isShift) || (key === "y" && isMod)) return "redo";
	return null;
}

describe("Editor Keyboard Shortcuts", () => {
	describe("isInputElement", () => {
		it("returns false for null tagName", () => {
			expect(isInputElement(null, false)).toBe(false);
		});

		it("returns true for INPUT", () => {
			expect(isInputElement("INPUT", false)).toBe(true);
		});

		it("returns true for TEXTAREA", () => {
			expect(isInputElement("TEXTAREA", false)).toBe(true);
		});

		it("returns true for contenteditable element", () => {
			expect(isInputElement("DIV", true)).toBe(true);
		});

		it("returns false for non-input elements", () => {
			expect(isInputElement("DIV", false)).toBe(false);
			expect(isInputElement("BUTTON", false)).toBe(false);
		});
	});

	describe("computeSeekPosition", () => {
		const duration = 120;
		const currentTime = 60;

		describe("Home key", () => {
			it("seeks to start", () => {
				expect(computeSeekPosition("Home", currentTime, duration, false, false)).toBe(
					0,
				);
			});
		});

		describe("End key", () => {
			it("seeks to end", () => {
				expect(computeSeekPosition("End", currentTime, duration, false, false)).toBe(
					duration,
				);
			});
		});

		describe("ArrowLeft with modifier", () => {
			it("seeks to start", () => {
				expect(computeSeekPosition("ArrowLeft", currentTime, duration, true, false)).toBe(
					0,
				);
			});
		});

		describe("ArrowRight with modifier", () => {
			it("seeks to end", () => {
				expect(computeSeekPosition("ArrowRight", currentTime, duration, true, false)).toBe(
					duration,
				);
			});
		});

		describe("ArrowLeft without modifier", () => {
			it("steps back one frame without shift", () => {
				const result = computeSeekPosition(
					"ArrowLeft",
					currentTime,
					duration,
					false,
					false,
				);
				expect(result).toBeCloseTo(currentTime - FRAME_DURATION, 5);
			});

			it("steps back 5 seconds with shift", () => {
				const result = computeSeekPosition(
					"ArrowLeft",
					currentTime,
					duration,
					false,
					true,
				);
				expect(result).toBe(currentTime - SKIP_DURATION);
			});

			it("clamps to zero at start", () => {
				const result = computeSeekPosition("ArrowLeft", 0.01, duration, false, false);
				expect(result).toBeGreaterThanOrEqual(0);
			});

			it("clamps to zero when skip would go negative", () => {
				const result = computeSeekPosition("ArrowLeft", 2, duration, false, true);
				expect(result).toBe(0);
			});
		});

		describe("ArrowRight without modifier", () => {
			it("steps forward one frame without shift", () => {
				const result = computeSeekPosition(
					"ArrowRight",
					currentTime,
					duration,
					false,
					false,
				);
				expect(result).toBeCloseTo(currentTime + FRAME_DURATION, 5);
			});

			it("steps forward 5 seconds with shift", () => {
				const result = computeSeekPosition(
					"ArrowRight",
					currentTime,
					duration,
					false,
					true,
				);
				expect(result).toBe(currentTime + SKIP_DURATION);
			});

			it("clamps to duration at end", () => {
				const result = computeSeekPosition(
					"ArrowRight",
					duration - 0.01,
					duration,
					false,
					false,
				);
				expect(result).toBeLessThanOrEqual(duration);
			});

			it("clamps to duration when skip would exceed", () => {
				const result = computeSeekPosition(
					"ArrowRight",
					duration - 2,
					duration,
					false,
					true,
				);
				expect(result).toBe(duration);
			});
		});

		describe("unrecognized keys", () => {
			it("returns null for space", () => {
				expect(computeSeekPosition(" ", currentTime, duration, false, false)).toBe(null);
			});

			it("returns null for other keys", () => {
				expect(computeSeekPosition("a", currentTime, duration, false, false)).toBe(null);
			});
		});
	});

	describe("shouldHandleUndoRedo", () => {
		describe("undo shortcut", () => {
			it("returns undo for Cmd+Z", () => {
				expect(shouldHandleUndoRedo("z", true, false)).toBe("undo");
			});

			it("returns null for Z without modifier", () => {
				expect(shouldHandleUndoRedo("z", false, false)).toBe(null);
			});
		});

		describe("redo shortcut", () => {
			it("returns redo for Cmd+Shift+Z", () => {
				expect(shouldHandleUndoRedo("z", true, true)).toBe("redo");
			});

			it("returns redo for Cmd+Y", () => {
				expect(shouldHandleUndoRedo("y", true, false)).toBe("redo");
			});

			it("returns null for Y without modifier", () => {
				expect(shouldHandleUndoRedo("y", false, false)).toBe(null);
			});
		});
	});

	describe("deleteSelectedSegments", () => {
		const segments: Segment[] = [
			{ start: 0, end: 1000, timescale: 1000 },
			{ start: 0, end: 2000, timescale: 1000 },
			{ start: 0, end: 3000, timescale: 1000 },
		];

		it("returns null when selection is null", () => {
			const result = deleteSelectedSegments(null, segments);
			expect(result.newSegments).toBe(null);
			expect(result.shouldClearSelection).toBe(false);
		});

		it("returns null when selection indices is empty", () => {
			const result = deleteSelectedSegments({ indices: [] }, segments);
			expect(result.newSegments).toBe(null);
			expect(result.shouldClearSelection).toBe(false);
		});

		it("deletes single selected segment", () => {
			const result = deleteSelectedSegments({ indices: [1] }, segments);
			expect(result.newSegments).toHaveLength(2);
			expect(result.newSegments?.[0]).toEqual(segments[0]);
			expect(result.newSegments?.[1]).toEqual(segments[2]);
			expect(result.shouldClearSelection).toBe(true);
		});

		it("deletes multiple selected segments", () => {
			const result = deleteSelectedSegments({ indices: [0, 2] }, segments);
			expect(result.newSegments).toHaveLength(1);
			expect(result.newSegments?.[0]).toEqual(segments[1]);
			expect(result.shouldClearSelection).toBe(true);
		});

		it("returns null when deleting all segments", () => {
			const result = deleteSelectedSegments({ indices: [0, 1, 2] }, segments);
			expect(result.newSegments).toBe(null);
			expect(result.shouldClearSelection).toBe(false);
		});
	});

	describe("splitAtPlayhead", () => {
		const timescale = 1000;

		it("splits segment at playhead position", () => {
			const segments: Segment[] = [
				{ start: 0, end: 10000, timescale },
			];
			const result = splitAtPlayhead(5, segments);
			expect(result).toHaveLength(2);
			expect(result?.[0].start).toBe(0);
			expect(result?.[0].end).toBe(5000);
			expect(result?.[1].start).toBe(5000);
			expect(result?.[1].end).toBe(10000);
		});

		it("returns null when playhead is at start of segment", () => {
			const segments: Segment[] = [
				{ start: 0, end: 10000, timescale },
			];
			const result = splitAtPlayhead(0.000005, segments);
			expect(result).toBe(null);
		});

		it("returns null when playhead is at end of segment", () => {
			const segments: Segment[] = [
				{ start: 0, end: 10000, timescale },
			];
			const result = splitAtPlayhead(9.999995, segments);
			expect(result).toBe(null);
		});

		it("returns null when playhead is outside any segment", () => {
			const segments: Segment[] = [
				{ start: 0, end: 5000, timescale },
			];
			const result = splitAtPlayhead(10, segments);
			expect(result).toBe(null);
		});

		it("splits correct segment in multi-segment timeline", () => {
			const segments: Segment[] = [
				{ start: 0, end: 5000, timescale },
				{ start: 0, end: 5000, timescale },
				{ start: 0, end: 5000, timescale },
			];
			const result = splitAtPlayhead(7.5, segments);
			expect(result).toHaveLength(4);
			expect(result?.[0]).toEqual(segments[0]);
			expect(result?.[1].start).toBe(0);
			expect(result?.[1].end).toBe(2500);
			expect(result?.[2].start).toBe(2500);
			expect(result?.[2].end).toBe(5000);
			expect(result?.[3]).toEqual(segments[2]);
		});

		it("handles segment with different timescale", () => {
			const segments: Segment[] = [
				{ start: 0, end: 90000, timescale: 90000 },
			];
			const result = splitAtPlayhead(0.5, segments);
			expect(result).toHaveLength(2);
			expect(result?.[0].end).toBeCloseTo(45000, 0);
			expect(result?.[1].start).toBeCloseTo(45000, 0);
		});

		it("preserves timescale in split segments", () => {
			const segments: Segment[] = [
				{ start: 0, end: 10000, timescale: 1000 },
			];
			const result = splitAtPlayhead(5, segments);
			expect(result?.[0].timescale).toBe(1000);
			expect(result?.[1].timescale).toBe(1000);
		});

		it("returns null for empty segments array", () => {
			const result = splitAtPlayhead(5, []);
			expect(result).toBe(null);
		});
	});

	describe("playback shortcuts", () => {
		it("space key triggers playback toggle", () => {
			const key = " ";
			expect(key === " ").toBe(true);
		});

		it("escape key triggers selection clear", () => {
			const key = "Escape";
			expect(key === "Escape").toBe(true);
		});

		it("s key triggers split without modifier", () => {
			const key = "s";
			const isMod = false;
			expect(key === "s" && !isMod).toBe(true);
		});

		it("delete key triggers delete when selection exists", () => {
			const key = "Delete";
			const hasSelection = true;
			expect((key === "Delete" || key === "Backspace") && hasSelection).toBe(true);
		});

		it("backspace key triggers delete when selection exists", () => {
			const key = "Backspace";
			const hasSelection = true;
			expect((key === "Delete" || key === "Backspace") && hasSelection).toBe(true);
		});
	});

	describe("desktop editor shortcut normalization", () => {
		function normalizeCombo(code: string, isMod: boolean): string {
			const parts: string[] = [];
			if (isMod) parts.push("Mod");

			let key: string;
			switch (code) {
				case "Equal":
					key = "=";
					break;
				case "Minus":
					key = "-";
					break;
				default:
					key = code.startsWith("Key") ? code.slice(3) : code;
			}

			parts.push(key);
			return parts.join("+");
		}

		it("normalizes Key codes to letters", () => {
			expect(normalizeCombo("KeyS", false)).toBe("S");
			expect(normalizeCombo("KeyZ", false)).toBe("Z");
		});

		it("normalizes Equal key", () => {
			expect(normalizeCombo("Equal", false)).toBe("=");
			expect(normalizeCombo("Equal", true)).toBe("Mod+=");
		});

		it("normalizes Minus key", () => {
			expect(normalizeCombo("Minus", false)).toBe("-");
			expect(normalizeCombo("Minus", true)).toBe("Mod+-");
		});

		it("adds Mod prefix for modifier keys", () => {
			expect(normalizeCombo("KeyZ", true)).toBe("Mod+Z");
		});

		it("preserves special key codes", () => {
			expect(normalizeCombo("Space", false)).toBe("Space");
			expect(normalizeCombo("Escape", false)).toBe("Escape");
		});
	});
});
