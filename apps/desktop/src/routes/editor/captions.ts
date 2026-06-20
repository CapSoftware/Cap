import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { arch, type as osType } from "@tauri-apps/plugin-os";

import { defaultCaptionSettings } from "~/store/captions";
import {
	type CaptionData,
	type CaptionSegment,
	type CaptionTrackSegment,
	type CaptionWord,
	commands,
	type SegmentRecordings,
	type TimelineSegment,
} from "~/utils/tauri";
export const DEFAULT_CAPTION_MODEL = "best";
export const DEFAULT_WHISPER_CAPTION_MODEL = "small";
export const DEFAULT_CAPTION_LANGUAGE = "auto";
export const CAPTION_MODEL_FOLDER = "transcription_models";
export const PARAKEET_DIR_MODELS = new Set(["best", "best-max"]);

export function supportsParakeetTranscription() {
	return !(osType() === "macos" && arch() === "x86_64");
}

export function resolveCaptionModel(model: string | null | undefined) {
	const fallbackModel = supportsParakeetTranscription()
		? DEFAULT_CAPTION_MODEL
		: DEFAULT_WHISPER_CAPTION_MODEL;

	if (!model) return fallbackModel;
	if (!supportsParakeetTranscription() && PARAKEET_DIR_MODELS.has(model)) {
		return DEFAULT_WHISPER_CAPTION_MODEL;
	}
	return model;
}

export function getSelectedTranscriptionSettings() {
	const model = resolveCaptionModel(
		localStorage.getItem("selectedTranscriptionModel"),
	);
	const language =
		localStorage.getItem("selectedTranscriptionLanguage") ??
		DEFAULT_CAPTION_LANGUAGE;

	return {
		model,
		language,
	};
}

interface SourceToEditedMapping {
	sourceStart: number;
	sourceEnd: number;
	editedStart: number;
	timescale: number;
}

interface MappedTimeRange {
	start: number;
	end: number;
}

function buildSourceToEditedMappings(
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): SourceToEditedMapping[] {
	const recordingOffsets: number[] = [];
	let cumulativeOffset = 0;
	for (const rec of recordingSegments) {
		recordingOffsets.push(cumulativeOffset);
		cumulativeOffset += rec.display.duration;
	}

	const mappings: SourceToEditedMapping[] = [];
	let editedOffset = 0;

	for (const seg of timelineSegments) {
		const recIdx = seg.recordingSegment ?? 0;
		const recOff = recordingOffsets[recIdx] ?? 0;

		mappings.push({
			sourceStart: recOff + seg.start,
			sourceEnd: recOff + seg.end,
			editedStart: editedOffset,
			timescale: seg.timescale,
		});

		editedOffset += (seg.end - seg.start) / seg.timescale;
	}

	return mappings;
}

function mapTimeRangeWithinMapping(
	start: number,
	end: number,
	mapping: SourceToEditedMapping,
): MappedTimeRange | null {
	const overlapStart = Math.max(start, mapping.sourceStart);
	const overlapEnd = Math.min(end, mapping.sourceEnd);

	if (overlapStart >= overlapEnd) return null;

	return {
		start:
			mapping.editedStart +
			(overlapStart - mapping.sourceStart) / mapping.timescale,
		end:
			mapping.editedStart +
			(overlapEnd - mapping.sourceStart) / mapping.timescale,
	};
}

const CAPTION_EDL_SEPARATOR = "::edl";

function mappedCaptionSegmentId(
	baseId: string,
	index: number,
	total: number,
): string {
	return total === 1 ? baseId : `${baseId}${CAPTION_EDL_SEPARATOR}${index}`;
}

/**
 * Recovers the originating source caption id from a derived track segment id. A
 * single source caption can be split into several track segments when it spans
 * timeline cuts; they all share the same source id.
 */
export function sourceCaptionId(trackId: string): string {
	const index = trackId.indexOf(CAPTION_EDL_SEPARATOR);
	return index === -1 ? trackId : trackId.slice(0, index);
}

export function mapCaptionsToEditedTimeline(
	rawSegments: CaptionSegment[],
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): CaptionSegment[] {
	if (timelineSegments.length === 0 || recordingSegments.length === 0) {
		return rawSegments;
	}

	const mappings = buildSourceToEditedMappings(
		timelineSegments,
		recordingSegments,
	);

	const result: CaptionSegment[] = [];

	for (const caption of rawSegments) {
		const mappedCaptionSegments = mappings.flatMap((mapping) => {
			if (caption.words && caption.words.length > 0) {
				const mappedWords = caption.words.flatMap((word) => {
					const wordMapped = mapTimeRangeWithinMapping(
						word.start,
						word.end,
						mapping,
					);

					return wordMapped
						? [
								{
									text: word.text,
									start: wordMapped.start,
									end: wordMapped.end,
								},
							]
						: [];
				});

				if (mappedWords.length === 0) {
					return [];
				}

				return [
					{
						...caption,
						start: mappedWords[0]?.start ?? caption.start,
						end: mappedWords[mappedWords.length - 1]?.end ?? caption.end,
						text: getCaptionTextFromWords(mappedWords),
						words: mappedWords,
					},
				];
			}

			const mappedRange = mapTimeRangeWithinMapping(
				caption.start,
				caption.end,
				mapping,
			);

			return mappedRange
				? [
						{
							...caption,
							start: mappedRange.start,
							end: mappedRange.end,
							words: caption.words,
						},
					]
				: [];
		});

		mappedCaptionSegments.forEach((segment, index) => {
			result.push({
				...segment,
				id: mappedCaptionSegmentId(
					caption.id,
					index,
					mappedCaptionSegments.length,
				),
			});
		});
	}

	return result;
}

export function createCaptionTrackSegments(
	segments: CaptionSegment[],
): CaptionTrackSegment[] {
	return segments.map((segment) => ({
		id: segment.id,
		start: segment.start,
		end: segment.end,
		text: segment.text,
		words: segment.words ?? [],
		fadeDurationOverride: null,
		lingerDurationOverride: null,
		positionOverride: null,
		colorOverride: null,
		backgroundColorOverride: null,
		fontSizeOverride: null,
	}));
}

type CaptionTrackOverrides = Pick<
	CaptionTrackSegment,
	| "fadeDurationOverride"
	| "lingerDurationOverride"
	| "positionOverride"
	| "colorOverride"
	| "backgroundColorOverride"
	| "fontSizeOverride"
>;

const EMPTY_CAPTION_OVERRIDES: CaptionTrackOverrides = {
	fadeDurationOverride: null,
	lingerDurationOverride: null,
	positionOverride: null,
	colorOverride: null,
	backgroundColorOverride: null,
	fontSizeOverride: null,
};

/**
 * Projects the source-time caption master through the current edit list to
 * produce the output-time render track. This is the single source of truth for
 * `timeline.captionSegments`: deleting sections, trimming, reordering, or
 * inserting clips keeps captions aligned 1:1 without re-transcription. Per
 * source-caption style overrides are carried across by source id so manual
 * styling survives re-derivation.
 */
export function deriveCaptionTrackSegments(
	sourceSegments: CaptionSegment[],
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
	previousTrack: CaptionTrackSegment[] = [],
): CaptionTrackSegment[] {
	const overridesBySourceId = new Map<string, CaptionTrackOverrides>();
	for (const segment of previousTrack) {
		const id = sourceCaptionId(segment.id);
		if (!overridesBySourceId.has(id)) {
			overridesBySourceId.set(id, {
				fadeDurationOverride: segment.fadeDurationOverride ?? null,
				lingerDurationOverride: segment.lingerDurationOverride ?? null,
				positionOverride: segment.positionOverride ?? null,
				colorOverride: segment.colorOverride ?? null,
				backgroundColorOverride: segment.backgroundColorOverride ?? null,
				fontSizeOverride: segment.fontSizeOverride ?? null,
			});
		}
	}

	const mapped = mapCaptionsToEditedTimeline(
		sourceSegments,
		timelineSegments,
		recordingSegments,
	);

	return mapped
		.slice()
		.sort((a, b) => a.start - b.start)
		.map((segment) => ({
			id: segment.id,
			start: segment.start,
			end: segment.end,
			text: segment.text,
			words: segment.words ?? [],
			...(overridesBySourceId.get(sourceCaptionId(segment.id)) ??
				EMPTY_CAPTION_OVERRIDES),
		}));
}

/**
 * Maps a point in source/recording time to the first output-time position where
 * it appears in the edited timeline (used to seek from the transcript).
 */
export function mapSourceTimeToEdited(
	sourceTime: number,
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): number | null {
	const mappings = buildSourceToEditedMappings(
		timelineSegments,
		recordingSegments,
	);
	for (const mapping of mappings) {
		if (sourceTime >= mapping.sourceStart && sourceTime <= mapping.sourceEnd) {
			return (
				mapping.editedStart +
				(sourceTime - mapping.sourceStart) / mapping.timescale
			);
		}
	}
	return null;
}

/**
 * Maps a source/recording time range to the output-time ranges it occupies in
 * the edited timeline. A single source range can map to zero ranges (fully cut)
 * or several (split across non-contiguous clips).
 */
export function mapSourceRangeToEdited(
	sourceStart: number,
	sourceEnd: number,
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): MappedTimeRange[] {
	const mappings = buildSourceToEditedMappings(
		timelineSegments,
		recordingSegments,
	);
	const ranges: MappedTimeRange[] = [];
	for (const mapping of mappings) {
		const mapped = mapTimeRangeWithinMapping(sourceStart, sourceEnd, mapping);
		if (mapped) ranges.push(mapped);
	}
	return ranges;
}

/**
 * Maps a point in output/edited time back to source/recording time (used to
 * translate edits made against the rendered timeline onto the source caption
 * master).
 */
export function mapEditedTimeToSource(
	editedTime: number,
	timelineSegments: TimelineSegment[],
	recordingSegments: SegmentRecordings[],
): number | null {
	const mappings = buildSourceToEditedMappings(
		timelineSegments,
		recordingSegments,
	);
	for (const mapping of mappings) {
		const editedEnd =
			mapping.editedStart +
			(mapping.sourceEnd - mapping.sourceStart) / mapping.timescale;
		if (editedTime >= mapping.editedStart && editedTime <= editedEnd) {
			return (
				mapping.sourceStart +
				(editedTime - mapping.editedStart) * mapping.timescale
			);
		}
	}
	return null;
}

export function applyCaptionResultToProject<
	T extends {
		captions?:
			| ({
					segments: CaptionSegment[];
					settings?: Record<string, unknown> | null;
			  } & Record<string, unknown>)
			| null;
		timeline?:
			| ({
					segments: TimelineSegment[];
					captionSegments?: CaptionTrackSegment[] | null;
			  } & Record<string, unknown>)
			| null;
	},
>(
	currentProject: T,
	rawSegments: CaptionSegment[],
	recordingSegments: SegmentRecordings[],
	recordingDuration: number,
) {
	if (!currentProject.captions) {
		currentProject.captions = {
			segments: [],
			settings: { ...defaultCaptionSettings, enabled: true },
		} as NonNullable<T["captions"]>;
	}
	const captions = currentProject.captions;
	captions.settings = {
		...defaultCaptionSettings,
		...captions.settings,
		enabled: true,
	};
	if (!currentProject.timeline) {
		currentProject.timeline = {
			segments: [{ start: 0, end: recordingDuration, timescale: 1 }],
			zoomSegments: [],
			sceneSegments: [],
			maskSegments: [],
			textSegments: [],
			captionSegments: [],
			keyboardSegments: [],
		} as NonNullable<T["timeline"]>;
	}
	const timeline = currentProject.timeline;

	captions.segments = rawSegments;
	captions.sourceTimed = true;
	timeline.captionSegments = deriveCaptionTrackSegments(
		rawSegments,
		timeline.segments,
		recordingSegments,
		timeline.captionSegments ?? [],
	);
}

export async function getModelPath(modelName: string): Promise<string> {
	const base = await join(await appLocalDataDir(), CAPTION_MODEL_FOLDER);
	if (PARAKEET_DIR_MODELS.has(modelName)) {
		return await join(base, `parakeet-${modelName}`);
	}
	return await join(base, `${modelName}.bin`);
}

export async function transcribeEditorCaptions(
	videoPath: string,
	modelName = DEFAULT_CAPTION_MODEL,
	language = DEFAULT_CAPTION_LANGUAGE,
): Promise<CaptionData> {
	const resolvedModelName = resolveCaptionModel(modelName);
	const modelPath = await getModelPath(resolvedModelName);
	const engine = PARAKEET_DIR_MODELS.has(resolvedModelName)
		? "Parakeet"
		: "Whisper";
	return await commands.transcribeAudio(videoPath, modelPath, language, engine);
}

const CAPTION_ATTACHING_PUNCTUATION = new Set([
	",",
	".",
	"!",
	"?",
	";",
	":",
	"%",
	")",
	"]",
	"}",
	"'",
	"’",
	"、",
	"。",
	"！",
	"？",
	"；",
	"：",
	"，",
]);

function captionTokenAttachesToPrevious(text: string) {
	const firstChar = text.trim().charAt(0);
	return firstChar.length > 0 && CAPTION_ATTACHING_PUNCTUATION.has(firstChar);
}

export function getCaptionTextFromWords(words: CaptionWord[]) {
	let text = "";

	for (const word of words) {
		const wordText = word.text.trim();
		if (wordText.length === 0) continue;

		if (text.length > 0 && !captionTokenAttachesToPrevious(wordText)) {
			text += " ";
		}
		text += wordText;
	}

	return text;
}

export function syncCaptionWordsWithText(
	text: string,
	existingWords: CaptionWord[] | undefined,
	start: number,
	end: number,
): CaptionWord[] {
	const tokens = text
		.trim()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

	if (tokens.length === 0) {
		return [];
	}

	const baseWords = existingWords ?? [];
	if (baseWords.length === tokens.length && baseWords.length > 0) {
		return baseWords.map((word, index) => ({
			...word,
			text: tokens[index] ?? word.text,
		}));
	}

	const duration = Math.max(end - start, 0);
	const step = tokens.length > 0 ? duration / tokens.length : 0;

	return tokens.map((token, index) => {
		const source = baseWords[index];
		const wordStart = start + step * index;
		const wordEnd =
			index === tokens.length - 1 ? end : start + step * (index + 1);

		return {
			text: token,
			start: source?.start ?? wordStart,
			end: source?.end ?? wordEnd,
		};
	});
}

export function getCaptionGenerationErrorMessage(error: unknown) {
	let message = "Unknown error occurred";

	if (error instanceof Error) {
		message = error.message;
	} else if (typeof error === "string") {
		message = error;
	}

	if (message.includes("No audio stream found")) {
		return "No audio found in the video file";
	}

	if (message.includes("Model file not found")) {
		return "Caption model not found. Please download it first";
	}

	if (message.includes("Failed to load Whisper model")) {
		return "Failed to load the caption model. Try downloading it again";
	}

	if (
		message.includes("Parakeet transcription is not available on Intel macOS")
	) {
		return "Parakeet models are not available on Intel Macs. Use a Whisper model instead";
	}

	return message;
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

	describe("getCaptionTextFromWords", () => {
		it("attaches punctuation tokens to the previous word", () => {
			expect(
				getCaptionTextFromWords([
					{ text: "test", start: 0, end: 0.2 },
					{ text: ",", start: 0.2, end: 0.3 },
					{ text: "test", start: 0.3, end: 0.6 },
					{ text: ".", start: 0.6, end: 0.7 },
				]),
			).toBe("test, test.");
		});
	});

	describe("mapCaptionsToEditedTimeline", () => {
		it("splits caption words across retained timeline ranges", () => {
			const result = mapCaptionsToEditedTimeline(
				[
					{
						id: "caption",
						start: 0.4,
						end: 2.3,
						text: "hello world",
						words: [
							{ text: "hello", start: 0.4, end: 0.6 },
							{ text: "world", start: 2.1, end: 2.3 },
						],
					},
				],
				[
					{ start: 0, end: 1, timescale: 1, recordingSegment: 0 },
					{ start: 2, end: 3, timescale: 1, recordingSegment: 0 },
				],
				[{ display: { duration: 4 } } as SegmentRecordings],
			);

			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				id: "caption::edl0",
				start: 0.4,
				end: 0.6,
				text: "hello",
				words: [{ text: "hello", start: 0.4, end: 0.6 }],
			});
			expect(result[1]?.id).toBe("caption::edl1");
			expect(result[1]?.text).toBe("world");
			expect(result[1]?.start).toBeCloseTo(1.1);
			expect(result[1]?.end).toBeCloseTo(1.3);
			expect(result[1]?.words?.[0]?.text).toBe("world");
			expect(result[1]?.words?.[0]?.start).toBeCloseTo(1.1);
			expect(result[1]?.words?.[0]?.end).toBeCloseTo(1.3);
		});

		it("splits captions without word timing across retained timeline ranges", () => {
			const result = mapCaptionsToEditedTimeline(
				[
					{
						id: "caption",
						start: 0.25,
						end: 2.5,
						text: "hello world",
						words: [],
					},
				],
				[
					{ start: 0, end: 1, timescale: 1, recordingSegment: 0 },
					{ start: 2, end: 3, timescale: 1, recordingSegment: 0 },
				],
				[{ display: { duration: 4 } } as SegmentRecordings],
			);

			expect(result).toEqual([
				{
					id: "caption::edl0",
					start: 0.25,
					end: 1,
					text: "hello world",
					words: [],
				},
				{
					id: "caption::edl1",
					start: 1,
					end: 1.5,
					text: "hello world",
					words: [],
				},
			]);
		});
	});

	describe("deriveCaptionTrackSegments", () => {
		const sourceSegments: CaptionSegment[] = [
			{
				id: "capA",
				start: 1,
				end: 2,
				text: "a",
				words: [{ text: "a", start: 1, end: 2 }],
			},
			{
				id: "capB",
				start: 6,
				end: 7,
				text: "b",
				words: [{ text: "b", start: 6, end: 7 }],
			},
		];
		const recordings = [{ display: { duration: 10 } } as SegmentRecordings];

		it("follows clip reordering to keep captions on their content", () => {
			const reordered: TimelineSegment[] = [
				{ start: 5, end: 8, timescale: 1, recordingSegment: 0 },
				{ start: 0, end: 3, timescale: 1, recordingSegment: 0 },
			];

			const track = deriveCaptionTrackSegments(
				sourceSegments,
				reordered,
				recordings,
			);

			expect(track.map((s) => s.id)).toEqual(["capB", "capA"]);
			expect(track[0]?.start).toBeCloseTo(1);
			expect(track[0]?.end).toBeCloseTo(2);
			expect(track[1]?.start).toBeCloseTo(4);
			expect(track[1]?.end).toBeCloseTo(5);
		});

		it("drops captions whose content was cut out", () => {
			const cut: TimelineSegment[] = [
				{ start: 0, end: 3, timescale: 1, recordingSegment: 0 },
			];

			const track = deriveCaptionTrackSegments(sourceSegments, cut, recordings);

			expect(track.map((s) => s.id)).toEqual(["capA"]);
		});

		it("carries style overrides across re-derivation by source id", () => {
			const identity: TimelineSegment[] = [
				{ start: 0, end: 10, timescale: 1, recordingSegment: 0 },
			];

			const previous = deriveCaptionTrackSegments(
				sourceSegments,
				identity,
				recordings,
			).map((segment) =>
				segment.id === "capA" ? { ...segment, fontSizeOverride: 42 } : segment,
			);

			const rederived = deriveCaptionTrackSegments(
				sourceSegments,
				identity,
				recordings,
				previous,
			);

			expect(rederived.find((s) => s.id === "capA")?.fontSizeOverride).toBe(42);
		});
	});
}
