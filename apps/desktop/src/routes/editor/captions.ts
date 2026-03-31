import { appLocalDataDir, join } from "@tauri-apps/api/path";

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
export const DEFAULT_CAPTION_LANGUAGE = "auto";
export const CAPTION_MODEL_FOLDER = "transcription_models";
export const PARAKEET_DIR_MODELS = new Set(["best", "best-max"]);

export function getSelectedTranscriptionSettings() {
	const model =
		localStorage.getItem("selectedTranscriptionModel") ?? DEFAULT_CAPTION_MODEL;
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

function mappedCaptionSegmentId(
	baseId: string,
	index: number,
	total: number,
): string {
	return total === 1 ? baseId : `${baseId}-${index}`;
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
						text: mappedWords
							.map((word) => word.text.trim())
							.filter((text) => text.length > 0)
							.join(" "),
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

	const mappedSegments = mapCaptionsToEditedTimeline(
		rawSegments,
		timeline.segments,
		recordingSegments,
	);

	captions.segments = mappedSegments;
	timeline.captionSegments = createCaptionTrackSegments(mappedSegments);
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
	const modelPath = await getModelPath(modelName);
	const engine = PARAKEET_DIR_MODELS.has(modelName) ? "Parakeet" : "Whisper";
	return await commands.transcribeAudio(videoPath, modelPath, language, engine);
}

export function getCaptionTextFromWords(words: CaptionWord[]) {
	return words
		.map((word) => word.text.trim())
		.filter((word) => word.length > 0)
		.join(" ");
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

	return message;
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest;

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
				id: "caption-0",
				start: 0.4,
				end: 0.6,
				text: "hello",
				words: [{ text: "hello", start: 0.4, end: 0.6 }],
			});
			expect(result[1]?.id).toBe("caption-1");
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
					id: "caption-0",
					start: 0.25,
					end: 1,
					text: "hello world",
					words: [],
				},
				{
					id: "caption-1",
					start: 1,
					end: 1.5,
					text: "hello world",
					words: [],
				},
			]);
		});
	});
}
