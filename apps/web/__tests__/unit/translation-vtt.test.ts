import { describe, expect, it } from "vitest";
import {
	isCompleteTranslation,
	joinTranslationChunks,
	splitTranslationChunks,
} from "@/actions/videos/translation-vtt";

const source = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
Hello there

2
00:00:02.000 --> 00:00:04.000
How are you?

3
00:00:04.000 --> 00:00:06.000
See you soon`;

describe("translation VTT completeness", () => {
	it("rejects a translated file that stops before the original", () => {
		const truncated = source.replace(/\n\n3\n[\s\S]*$/, "");
		expect(isCompleteTranslation(source, truncated)).toBe(false);
	});

	it("rejects changed cue timing and empty cue text", () => {
		expect(
			isCompleteTranslation(
				source,
				source.replace("00:00:04.000", "00:00:04.100"),
			),
		).toBe(false);
		expect(
			isCompleteTranslation(source, source.replace("How are you?", "")),
		).toBe(false);
		expect(
			isCompleteTranslation(source, source.replace("\n2\n", "\n9\n")),
		).toBe(false);
	});

	it("joins long translations without dropping the final cue", () => {
		const timestamp = (seconds: number) =>
			`00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
		const cues = Array.from({ length: 180 }, (_, index) => {
			return `${index + 1}\n${timestamp(index)} --> ${timestamp(index + 1)}\nCaption ${index + 1} with enough text to require multiple chunks`;
		});
		const longSource = `WEBVTT\n\n${cues.join("\n\n")}`;
		const chunks = splitTranslationChunks(longSource);
		expect(chunks?.length).toBeGreaterThan(1);
		if (!chunks) throw new Error("Expected chunks");

		const translations = chunks.map((chunk) =>
			chunk.replaceAll("Caption", "Translated caption"),
		);
		const result = joinTranslationChunks(longSource, chunks, translations);
		expect(result).not.toBeNull();
		expect(isCompleteTranslation(longSource, result ?? "")).toBe(true);
		expect(result).toContain("Translated caption 180");
	});

	it("rejects an incomplete chunk without returning a partial file", () => {
		const chunks = splitTranslationChunks(source);
		if (!chunks) throw new Error("Expected chunks");
		expect(joinTranslationChunks(source, chunks, ["WEBVTT"])).toBeNull();
	});
});
