import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));

const {
	isWavContentType,
	meetingAskRequestSchema,
	meetingNotesRequestSchema,
	parseMeetingBody,
	parseTranscribeQuery,
} = await import("@/lib/meetings/schemas");

const SECRET = "confidential-roadmap-detail";
const text = (length: number) => "a".repeat(length);

const notes = (overrides: Record<string, unknown> = {}) =>
	parseMeetingBody(meetingNotesRequestSchema, {
		transcript: "Speaker 1: hello",
		...overrides,
	});

const ask = (overrides: Record<string, unknown> = {}) =>
	parseMeetingBody(meetingAskRequestSchema, {
		question: "What did we decide?",
		transcript: "Speaker 1: we ship Friday",
		...overrides,
	});

const section = { heading: "Decisions", instruction: "What was decided" };

describe("meeting notes request schema", () => {
	it("applies defaults for optional fields", () => {
		const result = notes();
		expect(result).toEqual({
			ok: true,
			data: {
				title: "",
				participants: [],
				rawNotesMarkdown: "",
				transcript: "Speaker 1: hello",
				transcriptTruncated: false,
				vocabulary: [],
				summaryLanguage: "auto",
			},
		});
	});

	it.each([
		["title", text(300), text(301)],
		["rawNotesMarkdown", text(50_000), text(50_001)],
		["transcript", text(1_000_000), text(1_000_001)],
	])("enforces the %s length limit", (field, atLimit, overLimit) => {
		expect(notes({ [field]: atLimit }).ok).toBe(true);
		const over = notes({ [field]: overLimit });
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.detail.startsWith(`${field}:`)).toBe(true);
	});

	it("limits participants, vocabulary and their fields", () => {
		const person = { name: "Ada", email: "ada@example.com", isSelf: false };
		expect(notes({ participants: Array(100).fill(person) }).ok).toBe(true);
		expect(notes({ participants: Array(101).fill(person) }).ok).toBe(false);
		expect(notes({ vocabulary: Array(200).fill("Cap") }).ok).toBe(true);
		expect(notes({ vocabulary: Array(201).fill("Cap") }).ok).toBe(false);
		expect(notes({ participants: [{ name: text(201) }] }).ok).toBe(false);
	});

	it("limits templates", () => {
		const template = (overrides: Record<string, unknown> = {}) =>
			notes({
				template: { name: "1:1", sections: [section], ...overrides },
			}).ok;
		expect(template({ sections: Array(12).fill(section) })).toBe(true);
		expect(template({ sections: Array(13).fill(section) })).toBe(false);
		expect(template({ sections: [] })).toBe(false);
		expect(template({ name: text(100), description: text(500) })).toBe(true);
		expect(template({ name: text(101) })).toBe(false);
		expect(template({ description: text(501) })).toBe(false);
		expect(
			template({ sections: [{ heading: text(120), instruction: text(500) }] }),
		).toBe(true);
		expect(template({ sections: [{ heading: text(121) }] })).toBe(false);
		expect(
			template({ sections: [{ heading: "A", instruction: text(501) }] }),
		).toBe(false);
		expect(template({ sections: [{ heading: "   " }] })).toBe(false);
	});

	it("limits regenerate input and heading count", () => {
		expect(
			notes({ previous: { markdown: text(100_000), instruction: text(2_000) } })
				.ok,
		).toBe(true);
		expect(
			notes({ previous: { markdown: text(100_001), instruction: "" } }).ok,
		).toBe(false);
		expect(
			notes({ previous: { markdown: "", instruction: text(2_001) } }).ok,
		).toBe(false);
		expect(notes({ headingCount: 3 }).ok).toBe(true);
		expect(notes({ headingCount: 10 }).ok).toBe(true);
		expect(notes({ headingCount: 2 }).ok).toBe(false);
		expect(notes({ headingCount: 11 }).ok).toBe(false);
		expect(notes({ headingCount: 4.5 }).ok).toBe(false);
	});

	it("validates dates, time zones and languages", () => {
		expect(
			notes({ startedAt: "2026-11-12T09:30:00Z", timezone: "Europe/London" })
				.ok,
		).toBe(true);
		expect(notes({ startedAt: "2026-11-12T09:30:00+01:00" }).ok).toBe(true);
		expect(notes({ startedAt: "yesterday" }).ok).toBe(false);
		expect(notes({ timezone: "Mars/Olympus" }).ok).toBe(false);
		expect(notes({ timezone: "posix/Mars/Olympus" }).ok).toBe(false);
		expect(notes({ summaryLanguage: "de" }).ok).toBe(true);
		expect(notes({ summaryLanguage: "xx" }).ok).toBe(false);
	});

	it("reads a zoneinfo posix or right link as its zone", () => {
		for (const zone of ["posix/Europe/Berlin", "right/Europe/Berlin"]) {
			const result = notes({ timezone: zone });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data.timezone).toBe("Europe/Berlin");
		}
	});

	it("needs a transcript or the user's notes", () => {
		expect(notes({ transcript: "  " }).ok).toBe(false);
		expect(notes({ transcript: "", rawNotesMarkdown: "- shipped" }).ok).toBe(
			true,
		);
	});

	it("never echoes submitted content in the error detail", () => {
		const results = [
			notes({ transcript: `${SECRET}${text(1_000_000)}` }),
			notes({ title: 42, transcript: SECRET }),
			notes({ summaryLanguage: SECRET }),
			notes({ timezone: SECRET }),
			notes({ startedAt: SECRET }),
			notes({ participants: [{ name: SECRET, isSelf: SECRET }] }),
		];
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.detail).not.toContain(SECRET);
		}
	});
});

describe("meeting ask request schema", () => {
	it("accepts limits and applies defaults", () => {
		expect(
			ask({
				question: text(4_000),
				transcript: text(400_000),
				notesMarkdown: text(100_000),
				history: Array(20).fill({ role: "user", content: text(8_000) }),
			}).ok,
		).toBe(true);
		expect(ask()).toMatchObject({
			ok: true,
			data: { notesMarkdown: "", history: [] },
		});
	});

	it("rejects values over the limits", () => {
		expect(ask({ question: text(4_001) }).ok).toBe(false);
		expect(ask({ question: "   " }).ok).toBe(false);
		expect(ask({ transcript: text(400_001) }).ok).toBe(false);
		expect(ask({ notesMarkdown: text(100_001) }).ok).toBe(false);
		expect(ask({ title: text(301) }).ok).toBe(false);
		expect(
			ask({ history: Array(21).fill({ role: "user", content: "hi" }) }).ok,
		).toBe(false);
		expect(ask({ history: [{ role: "user", content: text(8_001) }] }).ok).toBe(
			false,
		);
		expect(ask({ history: [{ role: "system", content: "hi" }] }).ok).toBe(
			false,
		);
		expect(ask({ transcript: "", notesMarkdown: "" }).ok).toBe(false);
	});
});

describe("meeting request limits count characters", () => {
	// The desktop clips by Unicode characters; an emoji is one character but
	// two UTF-16 units.
	const emoji = "\u{1F680}";
	const chars = (count: number) => `${text(count - 1)}${emoji}`;

	it("accepts text at the limit that holds characters outside the BMP", () => {
		expect(notes({ title: chars(300) }).ok).toBe(true);
		expect(notes({ rawNotesMarkdown: chars(50_000) }).ok).toBe(true);
		expect(notes({ participants: [{ name: chars(200) }] }).ok).toBe(true);
		expect(notes({ vocabulary: [chars(100)] }).ok).toBe(true);
		expect(
			notes({
				template: { name: chars(100), sections: [{ heading: chars(120) }] },
			}).ok,
		).toBe(true);
		expect(
			ask({ history: [{ role: "assistant", content: chars(8_000) }] }).ok,
		).toBe(true);
		expect(ask({ question: chars(4_000) }).ok).toBe(true);
		expect(ask({ notesMarkdown: chars(100_000) }).ok).toBe(true);
		expect(
			parseTranscribeQuery({ keywordsHeader: encodeURIComponent(chars(50)) })
				.ok,
		).toBe(true);
	});

	it("still rejects one character over the limit", () => {
		expect(notes({ title: chars(301) }).ok).toBe(false);
		expect(ask({ history: [{ role: "user", content: chars(8_001) }] }).ok).toBe(
			false,
		);
		expect(
			parseTranscribeQuery({ keywordsHeader: encodeURIComponent(chars(51)) })
				.ok,
		).toBe(false);
	});
});

describe("transcribe query", () => {
	const header = (terms: string[]) => terms.map(encodeURIComponent).join(",");

	it("defaults to auto with no keywords", () => {
		expect(parseTranscribeQuery({})).toEqual({
			ok: true,
			data: { language: "auto", keywords: [] },
		});
	});

	it("accepts supported languages only", () => {
		expect(parseTranscribeQuery({ language: "fr" })).toMatchObject({
			ok: true,
			data: { language: "fr" },
		});
		expect(parseTranscribeQuery({ language: "zh-Hant" }).ok).toBe(false);
		expect(parseTranscribeQuery({ language: "klingon" }).ok).toBe(false);
	});

	it("takes a speaker session and clip number for meeting clips", () => {
		expect(parseTranscribeQuery({ session: "doc_8f2:mic", seq: "12" })).toEqual(
			{
				ok: true,
				data: {
					language: "auto",
					keywords: [],
					speakers: { session: "doc_8f2:mic", seq: 12 },
				},
			},
		);
		expect(parseTranscribeQuery({ session: "doc_8f2:system" })).toMatchObject({
			ok: true,
			data: { speakers: { session: "doc_8f2:system", seq: 0 } },
		});
	});

	it("rejects malformed speaker sessions and clip numbers", () => {
		expect(parseTranscribeQuery({ seq: "3" })).toEqual({
			ok: false,
			detail: "seq: needs a session",
		});
		expect(parseTranscribeQuery({ session: "a b" }).ok).toBe(false);
		expect(parseTranscribeQuery({ session: "x".repeat(101) }).ok).toBe(false);
		expect(parseTranscribeQuery({ session: "s", seq: "-1" }).ok).toBe(false);
		expect(parseTranscribeQuery({ session: "s", seq: "1.5" }).ok).toBe(false);
	});

	it("rejects keywords in the URL without echoing them", () => {
		const result = parseTranscribeQuery({ keywordsQuery: SECRET });
		expect(result).toEqual({
			ok: false,
			detail: "keywords: send them in the x-cap-keywords header",
		});
	});

	it("decodes percent-encoded header terms, trimming and de-duplicating", () => {
		expect(
			parseTranscribeQuery({
				keywordsHeader: `${header(["Zürich", "a, b", "東京"])}, Cap ,,Cap`,
			}),
		).toMatchObject({
			ok: true,
			data: { keywords: ["Zürich", "a, b", "東京", "Cap"] },
		});
	});

	it("drops undecodable terms silently", () => {
		expect(
			parseTranscribeQuery({ keywordsHeader: "Cap,%E0%A4%A,%,Fable" }),
		).toMatchObject({ ok: true, data: { keywords: ["Cap", "Fable"] } });
	});

	it("applies the caps after decoding", () => {
		const terms = (count: number, length = 5) =>
			Array.from({ length: count }, (_, index) =>
				`${index}`.padEnd(length, "x"),
			);
		expect(
			parseTranscribeQuery({ keywordsHeader: header(terms(100)) }).ok,
		).toBe(true);
		expect(
			parseTranscribeQuery({ keywordsHeader: header(terms(101)) }).ok,
		).toBe(false);
		const fiftyEncoded = header(["é".repeat(50)]);
		expect(fiftyEncoded.length).toBeGreaterThan(50);
		expect(parseTranscribeQuery({ keywordsHeader: fiftyEncoded }).ok).toBe(
			true,
		);
		const tooLong = parseTranscribeQuery({
			keywordsHeader: header([`${SECRET}${text(50)}`]),
		});
		expect(tooLong.ok).toBe(false);
		if (!tooLong.ok) expect(tooLong.detail).not.toContain(SECRET);
	});

	it("ignores a header over 8,000 characters entirely", () => {
		const atLimit = `Cap,${"x".repeat(7_996)}`;
		expect(atLimit.length).toBe(8_000);
		expect(parseTranscribeQuery({ keywordsHeader: atLimit }).ok).toBe(false);
		expect(
			parseTranscribeQuery({ keywordsHeader: `${atLimit}x` }),
		).toMatchObject({ ok: true, data: { keywords: [] } });
	});
});

describe("isWavContentType", () => {
	it("matches audio/wav with parameters and rejects others", () => {
		expect(isWavContentType("audio/wav")).toBe(true);
		expect(isWavContentType("Audio/WAV; codecs=1")).toBe(true);
		expect(isWavContentType("audio/x-wav")).toBe(true);
		expect(isWavContentType("audio/mpeg")).toBe(false);
		expect(isWavContentType("application/octet-stream")).toBe(false);
		expect(isWavContentType(undefined)).toBe(false);
	});
});
