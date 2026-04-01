import { appLocalDataDir, join } from "@tauri-apps/api/path";

import {
	type CaptionData,
	type CaptionSegment,
	type CaptionTrackSegment,
	type CaptionWord,
	commands,
} from "~/utils/tauri";

export const DEFAULT_CAPTION_MODEL = "small";
export const DEFAULT_CAPTION_LANGUAGE = "auto";
export const CAPTION_MODEL_FOLDER = "transcription_models";

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

export async function transcribeEditorCaptions(
	videoPath: string,
	modelName = DEFAULT_CAPTION_MODEL,
	language = DEFAULT_CAPTION_LANGUAGE,
): Promise<CaptionData> {
	const modelPath = await join(
		await appLocalDataDir(),
		CAPTION_MODEL_FOLDER,
		`${modelName}.bin`,
	);

	return await commands.transcribeAudio(videoPath, modelPath, language);
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
