import type { VideoEditRange, VideoEditSpec } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	EDIT_TRANSCRIPT_VERSION,
	type EditTranscript,
	type EditTranscriptWord,
	remapEditTranscriptThroughSpec,
} from "@/lib/edit-transcript";
import {
	composeEditSpecs,
	getEditSpecOutputDuration,
	mapOutputRangeToSourceRanges,
	mapSourceTimeToOutputTime,
	normalizeKeepRanges,
} from "@/lib/video-edits";

function referenceClampMilliseconds(value: number, durationMs: number) {
	return Math.min(Math.max(Math.round(value), 0), durationMs);
}

function referenceRemap(
	transcript: EditTranscript,
	editSpec: VideoEditSpec,
): EditTranscript {
	const spec = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	const durationMs = Math.round(getEditSpecOutputDuration(spec) * 1000);
	const keepRanges = spec.keepRanges;
	const words: EditTranscriptWord[] = [];
	let rangeIndex = 0;

	for (const word of transcript.words) {
		const midpointSeconds = (word.startMs + word.endMs) / 2000;
		while (
			rangeIndex < keepRanges.length &&
			(keepRanges[rangeIndex]?.end ?? 0) < midpointSeconds
		) {
			rangeIndex++;
		}

		const range = keepRanges[rangeIndex];
		if (
			!range ||
			midpointSeconds < range.start ||
			midpointSeconds > range.end
		) {
			continue;
		}

		const clampedStartSeconds = Math.min(
			Math.max(word.startMs / 1000, range.start),
			range.end,
		);
		const clampedEndSeconds = Math.min(
			Math.max(word.endMs / 1000, range.start),
			range.end,
		);
		const outputStartSeconds = mapSourceTimeToOutputTime(
			clampedStartSeconds,
			spec,
		);
		if (outputStartSeconds === null) continue;

		const startMs = referenceClampMilliseconds(
			outputStartSeconds * 1000,
			durationMs,
		);
		const endMs = Math.max(
			referenceClampMilliseconds(
				outputStartSeconds * 1000 +
					(clampedEndSeconds - clampedStartSeconds) * 1000,
				durationMs,
			),
			startMs + 1,
		);
		if (endMs > durationMs) continue;

		words.push({ ...word, startMs, endMs });
	}

	words.sort(
		(left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
	);

	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: transcript.speechModelUsed,
		durationMs,
		languageCode: transcript.languageCode,
		words,
	};
}

function referenceCompose(
	previousSourceSpec: VideoEditSpec,
	nextOutputSpec: VideoEditSpec,
) {
	const previous = normalizeKeepRanges(
		previousSourceSpec.keepRanges,
		previousSourceSpec.sourceDuration,
	);
	const previousOutputDuration = getEditSpecOutputDuration(previous);
	const next = normalizeKeepRanges(
		nextOutputSpec.keepRanges,
		previousOutputDuration,
	);
	const sourceRanges = next.keepRanges.flatMap((range) =>
		mapOutputRangeToSourceRanges(range, previous),
	);

	return normalizeKeepRanges(sourceRanges, previous.sourceDuration);
}

function createRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

type Random = () => number;

function pick<T>(random: Random, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)] as T;
}

function randomDuration(random: Random) {
	const roll = random();
	if (roll < 0.03) return 0;
	if (roll < 0.05) return -5;
	if (roll < 0.06) return Number.NaN;
	if (roll < 0.3) return Math.round(random() * 600_000) / 1000;
	return random() * 600;
}

function randomKeepRanges(random: Random, duration: number, count: number) {
	const span = Number.isFinite(duration) && duration > 0 ? duration : 60;
	const ranges: VideoEditRange[] = [];
	let cursor = random() * span * 0.05;
	for (let index = 0; index < count; index++) {
		const roll = random();
		let start: number;
		let end: number;
		if (roll < 0.1 && ranges.length > 0) {
			const previous = ranges[ranges.length - 1] as VideoEditRange;
			start = previous.end;
			end = start + random() * 2;
		} else if (roll < 0.2 && ranges.length > 0) {
			const previous = ranges[ranges.length - 1] as VideoEditRange;
			start =
				previous.end + pick(random, [0.0004, 0.0005, 0.001, 0.0011, 0.0015]);
			end = start + random() * 2;
		} else if (roll < 0.3 && ranges.length > 0) {
			const previous = ranges[ranges.length - 1] as VideoEditRange;
			start = previous.start + (previous.end - previous.start) * random();
			end = start + random() * 3;
		} else if (roll < 0.35) {
			start = cursor;
			end = start + random() * 0.06;
		} else if (roll < 0.4) {
			start = cursor + random();
			end = start - random();
		} else if (roll < 0.43) {
			start = -random() * 5;
			end = random() * span * 0.1;
		} else if (roll < 0.46) {
			start = span - random() * 2;
			end = span + random() * 5;
		} else if (roll < 0.47) {
			start = Number.NaN;
			end = cursor;
		} else if (roll < 0.48) {
			start = cursor;
			end = Number.POSITIVE_INFINITY;
		} else {
			start = cursor + (random() * span) / Math.max(count, 1);
			end = start + (random() * span) / Math.max(count, 1);
			if (random() < 0.4) {
				start = Math.round(start * 1000) / 1000;
				end = Math.round(end * 1000) / 1000;
			}
		}
		ranges.push({ start, end });
		if (Number.isFinite(end)) cursor = Math.max(cursor, end);
	}
	for (let index = ranges.length - 1; index > 0; index--) {
		if (random() < 0.2) {
			const swap = Math.floor(random() * (index + 1));
			const current = ranges[index] as VideoEditRange;
			ranges[index] = ranges[swap] as VideoEditRange;
			ranges[swap] = current;
		}
	}
	return ranges;
}

function makeWord(index: number, startMs: number, endMs: number) {
	return {
		id: `word-${index}`,
		text: `w${index}`,
		startMs,
		endMs,
		confidence: null,
		speaker: null,
		channel: null,
	} satisfies EditTranscriptWord;
}

function randomTranscript(
	random: Random,
	spec: VideoEditSpec,
	wordCount: number,
): EditTranscript {
	const normalized = normalizeKeepRanges(spec.keepRanges, spec.sourceDuration);
	const durationMs = Math.max(
		1,
		Math.round(
			(Number.isFinite(spec.sourceDuration) && spec.sourceDuration > 0
				? spec.sourceDuration
				: 60) * 1000,
		),
	);
	const boundariesMs = normalized.keepRanges.flatMap((range) => [
		range.start * 1000,
		range.end * 1000,
	]);
	const words: EditTranscriptWord[] = [];
	for (let index = 0; index < wordCount; index++) {
		const roll = random();
		let startMs: number;
		let endMs: number;
		if (roll < 0.25 && boundariesMs.length > 0) {
			const boundary = pick(random, boundariesMs);
			const width = 1 + Math.floor(random() * 400);
			const offset = pick(random, [0, -width, -width / 2, 1, -1, -0.5]);
			startMs = Math.max(0, boundary + offset);
			endMs = startMs + width;
			if (random() < 0.5) {
				startMs = Math.round(startMs);
				endMs = Math.round(endMs);
			}
		} else if (roll < 0.27) {
			startMs = pick(random, [Number.NaN, 0, durationMs]);
			endMs = pick(random, [Number.NaN, durationMs, durationMs + 50]);
		} else {
			startMs = Math.floor(random() * durationMs);
			endMs = startMs + 1 + Math.floor(random() * 800);
		}
		words.push(makeWord(index, startMs, endMs));
	}
	if (random() < 0.9) {
		words.sort(
			(left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
		);
	}
	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: "test",
		durationMs,
		languageCode: null,
		words,
	};
}

function randomSpec(random: Random): VideoEditSpec {
	const duration = randomDuration(random);
	const count = pick(random, [0, 1, 2, 3, 5, 10, 40, 200]);
	return {
		version: 1,
		sourceDuration: duration,
		keepRanges: randomKeepRanges(random, duration, count),
	};
}

function uniformSpec(durationSeconds: number, rangeCount: number) {
	const slot = durationSeconds / rangeCount;
	const keepRanges: VideoEditRange[] = [];
	for (let index = 0; index < rangeCount; index++) {
		keepRanges.push({
			start: index * slot + slot * 0.1,
			end: index * slot + slot * 0.9,
		});
	}
	return {
		version: 1,
		sourceDuration: durationSeconds,
		keepRanges,
	} satisfies VideoEditSpec;
}

function uniformTranscript(durationSeconds: number, wordCount: number) {
	const durationMs = durationSeconds * 1000;
	const step = durationMs / wordCount;
	const words: EditTranscriptWord[] = [];
	for (let index = 0; index < wordCount; index++) {
		const startMs = Math.round(index * step);
		words.push(makeWord(index, startMs, startMs + Math.max(1, step * 0.8)));
	}
	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: "test",
		durationMs,
		languageCode: null,
		words,
	} satisfies EditTranscript;
}

describe("remapEditTranscriptThroughSpec equivalence", () => {
	it("matches the reference on hand-picked edge cases", () => {
		const cases: [VideoEditSpec, EditTranscript][] = [];
		const words = [
			makeWord(0, 0, 100),
			makeWord(1, 900, 1100),
			makeWord(2, 1000, 1000.5),
			makeWord(3, 1999, 2001),
			makeWord(4, 2000, 2100),
			makeWord(5, 2500, 3500),
			makeWord(6, 4000, 9000),
			makeWord(7, Number.NaN, 5000),
			makeWord(8, 9000, Number.POSITIVE_INFINITY),
		];
		const transcript: EditTranscript = {
			version: EDIT_TRANSCRIPT_VERSION,
			speechModelUsed: "test",
			durationMs: 10_000,
			languageCode: null,
			words,
		};
		for (const keepRanges of [
			[],
			[{ start: 0, end: 10 }],
			[
				{ start: 1, end: 2 },
				{ start: 2, end: 3 },
			],
			[
				{ start: 1, end: 2 },
				{ start: 2.001, end: 3 },
			],
			[
				{ start: 1, end: 2 },
				{ start: 2.0015, end: 3 },
			],
			[
				{ start: 3, end: 1 },
				{ start: 1.5, end: 4 },
			],
			[
				{ start: 0.1, end: 0.12 },
				{ start: 5, end: 20 },
			],
			[{ start: 11, end: 12 }],
		]) {
			cases.push([{ version: 1, sourceDuration: 10, keepRanges }, transcript]);
		}
		cases.push([
			{ version: 1, sourceDuration: 0, keepRanges: [{ start: 0, end: 5 }] },
			transcript,
		]);
		for (const [spec, input] of cases) {
			expect(remapEditTranscriptThroughSpec(input, spec)).toEqual(
				referenceRemap(input, spec),
			);
		}
	});

	it("matches the reference on randomised specs and transcripts", () => {
		const random = createRandom(0x5eed);
		let keptWords = 0;
		for (let iteration = 0; iteration < 1500; iteration++) {
			const spec = randomSpec(random);
			const transcript = randomTranscript(
				random,
				spec,
				pick(random, [0, 1, 5, 50, 300]),
			);
			const actual = remapEditTranscriptThroughSpec(transcript, spec);
			expect(actual).toEqual(referenceRemap(transcript, spec));
			keptWords += actual.words.length;
		}
		expect(keptWords).toBeGreaterThan(10_000);
	});
});

describe("composeEditSpecs equivalence", () => {
	it("matches the reference on randomised specs", () => {
		const random = createRandom(0xc0de);
		let composedRanges = 0;
		for (let iteration = 0; iteration < 1500; iteration++) {
			const previous = randomSpec(random);
			const previousOutput = getEditSpecOutputDuration(
				normalizeKeepRanges(previous.keepRanges, previous.sourceDuration),
			);
			const next: VideoEditSpec = {
				version: 1,
				sourceDuration: previousOutput,
				keepRanges: randomKeepRanges(
					random,
					previousOutput,
					pick(random, [0, 1, 3, 10, 50]),
				),
			};
			const actual = composeEditSpecs(previous, next);
			expect(actual).toEqual(referenceCompose(previous, next));
			composedRanges += actual.keepRanges.length;
		}
		expect(composedRanges).toBeGreaterThan(1000);
	});
});

describe("remapEditTranscriptThroughSpec benchmark", () => {
	it.skipIf(!process.env.CAP_BENCH_EDIT_TRANSCRIPT_REMAP)(
		"measures 9000 words across keep range counts",
		() => {
			const wordCount = 9000;
			const durationSeconds = 3600;
			const transcript = uniformTranscript(durationSeconds, wordCount);
			const runs = 9;
			for (const rangeCount of [1, 50, 200, 1000]) {
				const spec = uniformSpec(durationSeconds, rangeCount);
				const expected = referenceRemap(transcript, spec);
				expect(expected.words.length).toBeGreaterThan(wordCount / 2);
				expect(remapEditTranscriptThroughSpec(transcript, spec)).toEqual(
					expected,
				);
				for (let warmup = 0; warmup < 3; warmup++) {
					referenceRemap(transcript, spec);
					remapEditTranscriptThroughSpec(transcript, spec);
				}
				const oldTimes: number[] = [];
				const newTimes: number[] = [];
				for (let run = 0; run < runs; run++) {
					let start = performance.now();
					const oldResult = referenceRemap(transcript, spec);
					oldTimes.push(performance.now() - start);
					start = performance.now();
					const newResult = remapEditTranscriptThroughSpec(transcript, spec);
					newTimes.push(performance.now() - start);
					expect(newResult.words.length).toBe(oldResult.words.length);
				}
				const summary = (times: number[]) => {
					const sorted = [...times].sort((a, b) => a - b);
					return {
						medianMs: Number(sorted[Math.floor(runs / 2)]?.toFixed(3)),
						minMs: Number(sorted[0]?.toFixed(3)),
						maxMs: Number(sorted[runs - 1]?.toFixed(3)),
					};
				};
				console.log(
					JSON.stringify({
						wordCount,
						rangeCount,
						keptWords: expected.words.length,
						runs,
						old: summary(oldTimes),
						new: summary(newTimes),
					}),
				);
			}
		},
	);
});
