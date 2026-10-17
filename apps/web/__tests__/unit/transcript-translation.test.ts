import { describe, expect, it } from "vitest";
import { isValidTranscriptTranslation } from "@/lib/transcript-vtt";

const source =
	"WEBVTT\n\n1\n00:00:00.125 --> 00:00:01.500\n<v Speaker A>Hello there.</v>\n\n2\n00:00:01.600 --> 00:00:03.000\n<v Speaker B>Good morning.</v>\n";
const translated = source
	.replace("Hello there.", "Merhaba.")
	.replace("Good morning.", "Günaydın.");

describe("translation structure validation", () => {
	it("accepts translated speech with unchanged voices and timings", () => {
		expect(isValidTranscriptTranslation(source, translated)).toBe(true);
		expect(
			isValidTranscriptTranslation(source, translated.replace(/\n/g, "\r\n")),
		).toBe(true);
		expect(
			isValidTranscriptTranslation(
				source,
				translated.replace("Merhaba.", "Merhaba\narkadaşım."),
			),
		).toBe(true);
	});
	it.each([
		translated.replace("<v Speaker A>", ""),
		translated.replace("<v Speaker A>", "<v Speaker B>"),
		translated.replace("<v Speaker A>", "<v Konuşmacı A>"),
		translated.replace("</v>", ""),
		translated.replace("Merhaba.", "Merhaba.<v Speaker B>Ek söz.</v>"),
		translated.replace("00:00:00.125", "00:00:00.000"),
		translated.replace("\n2\n", "\n3\n"),
		translated.split("\n\n2")[0] ?? "",
		translated.replace("Merhaba.", ""),
		`Here is the WEBVTT:\n${translated}`,
		`${translated}\nExtra explanation`,
	])("rejects changed metadata or malformed cues before caching", (value) => {
		expect(isValidTranscriptTranslation(source, value)).toBe(false);
	});
	it("accepts legacy captions but rejects invented speakers", () => {
		const legacy = source.replace(/<[^>]*>/g, "");
		expect(
			isValidTranscriptTranslation(legacy, legacy.replace("Hello", "Merhaba")),
		).toBe(true);
		expect(isValidTranscriptTranslation(legacy, translated)).toBe(false);
	});
});
