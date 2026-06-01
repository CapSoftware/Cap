const FILLER_WORDS = new Set(["uh", "um", "ah", "er", "hmm", "mhm"]);

export function isFillerWord(text: string): boolean {
	const normalized = text.toLowerCase().replace(/[^a-z]/g, "");
	return FILLER_WORDS.has(normalized);
}

export const PAUSE_DETECTION_THRESHOLD = 0.5;
export const AUTO_CLEAN_SILENCE_THRESHOLD = 1.5;
export const DEFAULT_PAUSE_BUFFER = 0.0;

export interface PauseEntry {
	text: string;
	start: number;
	end: number;
	duration: number;
	deleted: boolean;
	isPause: true;
	isFiller: false;
	bufferStart: number;
	bufferEnd: number;
	segmentIndex: number;
	afterWordIndex: number;
}

export function detectPauses(
	words: Array<{
		start: number;
		end: number;
		segmentIndex: number;
		wordIndex: number;
	}>,
	threshold = PAUSE_DETECTION_THRESHOLD,
): PauseEntry[] {
	const pauses: PauseEntry[] = [];
	for (let i = 1; i < words.length; i++) {
		const prev = words[i - 1];
		const curr = words[i];
		const gap = curr.start - prev.end;
		if (gap >= threshold) {
			pauses.push({
				text: `[Pause ${gap.toFixed(1)}s]`,
				start: prev.end,
				end: curr.start,
				duration: gap,
				deleted: false,
				isPause: true,
				isFiller: false,
				bufferStart: DEFAULT_PAUSE_BUFFER,
				bufferEnd: DEFAULT_PAUSE_BUFFER,
				segmentIndex: prev.segmentIndex,
				afterWordIndex: prev.wordIndex,
			});
		}
	}
	return pauses;
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

	describe("isFillerWord", () => {
		it("detects basic filler words", () => {
			expect(isFillerWord("uh")).toBe(true);
			expect(isFillerWord("um")).toBe(true);
			expect(isFillerWord("hmm")).toBe(true);
		});

		it("ignores punctuation and capitalization", () => {
			expect(isFillerWord("Uh,")).toBe(true);
			expect(isFillerWord("UM...")).toBe(true);
			expect(isFillerWord("er?")).toBe(true);
		});

		it("returns false for non-filler words", () => {
			expect(isFillerWord("hello")).toBe(false);
			expect(isFillerWord("the")).toBe(false);
			expect(isFillerWord("under")).toBe(false);
		});
	});

	describe("detectPauses", () => {
		it("detects pauses above threshold", () => {
			const words = [
				{ start: 0, end: 1.0, segmentIndex: 0, wordIndex: 0 },
				{ start: 1.6, end: 2.0, segmentIndex: 0, wordIndex: 1 },
			];
			const pauses = detectPauses(words, 0.5);
			expect(pauses).toHaveLength(1);
			expect(pauses[0].duration).toBeCloseTo(0.6);
			expect(pauses[0].start).toBe(1.0);
			expect(pauses[0].end).toBe(1.6);
			expect(pauses[0].isPause).toBe(true);
			expect(pauses[0].text).toBe("[Pause 0.6s]");
		});

		it("ignores pauses below threshold", () => {
			const words = [
				{ start: 0, end: 1.0, segmentIndex: 0, wordIndex: 0 },
				{ start: 1.2, end: 2.0, segmentIndex: 0, wordIndex: 1 },
			];
			const pauses = detectPauses(words, 0.5);
			expect(pauses).toHaveLength(0);
		});
	});
}
