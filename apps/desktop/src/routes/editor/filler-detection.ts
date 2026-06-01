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
