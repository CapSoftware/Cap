import { describe, expect, it } from "vitest";
import {
	isCompleteTranslation,
	restoreTranslationVoices,
	translationTextOnly,
	withSourceFingerprint,
} from "@/actions/videos/translation-vtt";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import { updateVttEntryText } from "@/lib/transcript-vtt";

const cue = (text: string) =>
	`WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n${text}\n`;

describe("transcript attribution boundaries", () => {
	it("keeps canonical identity outside the model and reassembles only validated text", () => {
		const source = cue("<v A>Hello &amp; welcome</v>");
		expect(translationTextOnly(source)).not.toContain("<v A>");
		const restored = restoreTranslationVoices(
			source,
			cue("Hola &amp; bienvenido"),
		);
		expect(parseTranscriptVTT(restored ?? "")[0]).toMatchObject({
			speaker: "A",
			text: "Hola & bienvenido",
		});
		for (const text of [
			"<v B>Hola</v>",
			"<v A>Hola</v>",
			"<v B>Hola",
			"</v>Hola",
		]) {
			expect(restoreTranslationVoices(source, cue(text))).toBeNull();
		}
	});
	it.each([null, undefined, "<invalid>", "__proto__", "A"])(
		"round trips literal provider text for speaker %s",
		(speaker) => {
			const text = "<v B>not an identity</v> & <other> &lt;";
			const result = parseTranscriptVTT(
				formatToWebVTT({ words: [{ text, start: 0, end: 1000, speaker }] }),
			);
			expect(result[0]?.text).toBe(text);
			expect(result[0]?.speaker).toBe(speaker === "A" ? "A" : undefined);
		},
	);
	it.each(["plain", "<v A>known</v>"])(
		"round trips edited literal text without introducing identities: %s",
		(original) => {
			const text = "<v B>literal</v> & <other> &lt;";
			const edited = updateVttEntryText(cue(original), 1, text);
			expect(parseTranscriptVTT(edited.content)[0]?.text).toBe(text);
			expect(parseTranscriptVTT(edited.content)[0]?.speaker).toBe(
				original === "plain" ? undefined : "A",
			);
		},
	);
	it.each(["<v B>Hola</v>", "Hola", "<v A><v B>Hola</v></v>"])(
		"rejects altered translation voice metadata before cache: %s",
		(text) => {
			const source = cue("<v A>Hello</v>");
			expect(isCompleteTranslation(source, cue(text))).toBe(false);
			expect(withSourceFingerprint(source, cue(text))).toBeNull();
		},
	);
	it("rejects fabricated voice metadata on an unknown source", () => {
		expect(isCompleteTranslation(cue("Hello"), cue("<v A>Hola</v>"))).toBe(
			false,
		);
	});
	it("retains standard legacy voice annotations without claiming their provenance", () => {
		expect(parseTranscriptVTT(cue("<v A>Legacy voice"))[0]).toMatchObject({
			speaker: "A",
			text: "Legacy voice",
		});
		expect(
			parseTranscriptVTT(cue("Legacy &amp; &lt;text&gt;"))[0],
		).toMatchObject({ text: "Legacy & <text>" });
	});
});
