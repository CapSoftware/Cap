export const CAPTION_LINE_CHARACTERS = 42;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_MAX_CUE_MS = 7_000;
export const CAPTION_PAUSE_MS = 1_000;
export const CAPTION_MIN_CUE_MS = 1_000;
export const CAPTION_READING_MS_PER_CHARACTER = 50;

export type CaptionWord = { text: string; start: number; end: number };

export type CaptionCue = { start: number; end: number; lines: string[] };

type TimedWord = { text: string; start: number; end: number };

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:，、；：]["'”’)\]]*$/;

const isControl = (char: string) => {
	const code = char.codePointAt(0) ?? 0;
	return code < 32 || code === 127;
};

const cleanText = (text: string) =>
	Array.from(text, (char) => (isControl(char) ? " " : char))
		.join("")
		.replace(/\s+/g, " ")
		.trim();

const milliseconds = (seconds: number) =>
	Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;

function timedWords(words: readonly CaptionWord[]): TimedWord[] {
	const timed: TimedWord[] = [];
	let floor = 0;
	for (const word of words) {
		const text = typeof word?.text === "string" ? cleanText(word.text) : "";
		if (text.length === 0) continue;
		const start = Math.max(floor, milliseconds(word.start));
		const end = Math.max(start, milliseconds(word.end));
		floor = start;
		for (const part of text.split(" ")) {
			timed.push({ text: part, start, end });
		}
	}
	return timed;
}

const joined = (words: readonly TimedWord[]) =>
	words.map((word) => word.text).join(" ");

function layoutLines(words: readonly TimedWord[]): string[] | null {
	const text = joined(words);
	if (words.length <= 1 || text.length <= CAPTION_LINE_CHARACTERS) {
		return [text];
	}
	let best: { lines: string[]; score: number } | null = null;
	for (let split = 1; split < words.length; split++) {
		const first = joined(words.slice(0, split));
		const second = joined(words.slice(split));
		const fits = (line: string, count: number) =>
			line.length <= CAPTION_LINE_CHARACTERS || count === 1;
		if (!fits(first, split) || !fits(second, words.length - split)) continue;
		const lastOfFirst = words[split - 1]?.text ?? "";
		const score =
			Math.abs(first.length - second.length) -
			(SENTENCE_END.test(lastOfFirst) || CLAUSE_END.test(lastOfFirst) ? 6 : 0);
		if (!best || score < best.score) {
			best = { lines: [first, second], score };
		}
	}
	return best?.lines ?? null;
}

const fitsOneCue = (words: readonly TimedWord[]) => {
	const first = words[0];
	const last = words[words.length - 1];
	if (!first || !last) return true;
	if (words.length === 1) return true;
	return (
		last.end - first.start <= CAPTION_MAX_CUE_MS && layoutLines(words) !== null
	);
};

function clauseBreak(words: readonly TimedWord[]) {
	const total = joined(words).length;
	for (let index = words.length - 2; index >= 0; index--) {
		const kept = joined(words.slice(0, index + 1)).length;
		if (kept * 2 < total) return null;
		if (CLAUSE_END.test(words[index]?.text ?? "")) return index + 1;
	}
	return null;
}

function groupWords(words: readonly TimedWord[]): TimedWord[][] {
	const groups: TimedWord[][] = [];
	let current: TimedWord[] = [];
	const flush = () => {
		if (current.length > 0) groups.push(current);
		current = [];
	};
	for (const word of words) {
		const previous = current[current.length - 1];
		if (previous && word.start - previous.end > CAPTION_PAUSE_MS) flush();
		if (current.length > 0 && !fitsOneCue([...current, word])) {
			const at = clauseBreak(current);
			if (at !== null && fitsOneCue([...current.slice(at), word])) {
				groups.push(current.slice(0, at));
				current = current.slice(at);
			} else {
				flush();
			}
		}
		current.push(word);
		if (SENTENCE_END.test(word.text)) flush();
	}
	flush();
	return groups;
}

export function buildCaptionCues(
	words: readonly CaptionWord[],
	durationSeconds?: number | null,
): CaptionCue[] {
	const groups = groupWords(timedWords(words));
	const mediaEnd =
		typeof durationSeconds === "number" && durationSeconds > 0
			? milliseconds(durationSeconds)
			: null;
	const cues: CaptionCue[] = [];
	let previousEnd = 0;
	groups.forEach((group, index) => {
		const first = group[0];
		const last = group[group.length - 1];
		if (!first || !last) return;
		const start = Math.max(first.start, previousEnd);
		const spoken = Math.max(last.end, start);
		const nextStart = groups[index + 1]?.[0]?.start;
		const wanted = Math.max(
			spoken,
			start + CAPTION_MIN_CUE_MS,
			start + joined(group).length * CAPTION_READING_MS_PER_CHARACTER,
		);
		const room =
			nextStart !== undefined
				? Math.max(spoken, nextStart)
				: mediaEnd !== null
					? Math.max(spoken, mediaEnd)
					: wanted;
		const end = Math.max(
			start + 1,
			Math.min(wanted, room, start + CAPTION_MAX_CUE_MS),
		);
		cues.push({ start, end, lines: layoutLines(group) ?? [joined(group)] });
		previousEnd = end;
	});
	return cues;
}

const pad = (value: number, width: number) =>
	String(value).padStart(width, "0");

export function formatVttTimestamp(totalMilliseconds: number) {
	const whole = Math.max(0, Math.round(totalMilliseconds));
	const hours = Math.floor(whole / 3_600_000);
	const minutes = Math.floor((whole % 3_600_000) / 60_000);
	const seconds = Math.floor((whole % 60_000) / 1000);
	return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(whole % 1000, 3)}`;
}

export const escapeVttText = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildWebVtt(
	words: readonly CaptionWord[] | null | undefined,
	durationSeconds?: number | null,
): string | null {
	const cues = buildCaptionCues(words ?? [], durationSeconds);
	if (cues.length === 0) return null;
	const blocks = cues.map(
		(cue) =>
			`${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.lines
				.map(escapeVttText)
				.join("\n")}`,
	);
	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
