import { describe, expect, it } from "vitest";
import {
	MEETING_NOTES_TRANSCRIPT_MAX_CHARS,
	MEETING_SHARE_MAX_DURATION_SECONDS,
	MEETING_SHARE_NOTES_MAX_CHARS,
	MEETING_SHARE_SUMMARY_MAX_CHARS,
	MEETING_SHARE_TITLE_MAX_CHARS,
	MEETING_SHARE_TRANSCRIPT_MAX_TURNS,
	MEETING_SHARE_TURN_MAX_CHARS,
	meetingShareDocumentIdSchema,
	meetingShareRequestSchema,
	parseMeetingBody,
} from "@/lib/meetings/schemas";

const note = {
	documentId: "doc_weekly-sync",
	title: "Weekly sync",
	summaryMarkdown: "## Summary\n\nShip on Monday.",
};

const parse = (body: unknown) =>
	parseMeetingBody(meetingShareRequestSchema, body);

const rejected = (body: unknown) => {
	const result = parse(body);
	return result.ok ? null : result.detail;
};

describe("note share request", () => {
	it("accepts the smallest note and fills the optional fields", () => {
		const result = parse(note);

		expect(result).toEqual({
			ok: true,
			data: { ...note, notesMarkdown: "", participants: [] },
		});
	});

	it("accepts a full note", () => {
		const full = {
			...note,
			orgId: "0123456789abcde",
			notesMarkdown: "- [ ] Email the list",
			transcript: [{ speaker: "Sam", startMs: 0, text: "Morning." }],
			participants: ["Sam", "Priya"],
			startedAt: "2026-11-27T10:00:00+01:00",
			durationSeconds: 1_934.5,
		};

		expect(parse(full)).toEqual({ ok: true, data: full });
	});

	it("accepts a note that is only the owner's own notes", () => {
		expect(
			parse({ documentId: "d1", notesMarkdown: "Call back Friday" }).ok,
		).toBe(true);
	});

	it.each([
		[{ ...note, summaryMarkdown: "  ", notesMarkdown: "\n" }, "required"],
		[{ ...note, documentId: "" }, "documentId"],
		[{ ...note, documentId: "a".repeat(65) }, "documentId"],
		[{ ...note, documentId: "../etc" }, "documentId"],
		[{ ...note, documentId: 7 }, "documentId"],
		[{ ...note, orgId: "org id" }, "orgId"],
		[
			{ ...note, title: "a".repeat(MEETING_SHARE_TITLE_MAX_CHARS + 1) },
			"title",
		],
		[
			{
				...note,
				summaryMarkdown: "a".repeat(MEETING_SHARE_SUMMARY_MAX_CHARS + 1),
			},
			"summaryMarkdown",
		],
		[
			{ ...note, notesMarkdown: "a".repeat(MEETING_SHARE_NOTES_MAX_CHARS + 1) },
			"notesMarkdown",
		],
		[{ ...note, summaryMarkdown: "a\u0000b" }, "summaryMarkdown"],
		[{ ...note, participants: Array(101).fill("Sam") }, "participants"],
		[{ ...note, participants: ["a".repeat(201)] }, "participants.0"],
		[{ ...note, participants: "Sam" }, "participants"],
		[{ ...note, startedAt: "yesterday" }, "startedAt"],
		[{ ...note, startedAt: "2026-11-27T10:00:00" }, "startedAt"],
		[{ ...note, durationSeconds: -1 }, "durationSeconds"],
		[
			{ ...note, durationSeconds: MEETING_SHARE_MAX_DURATION_SECONDS + 1 },
			"durationSeconds",
		],
		[{ ...note, durationSeconds: "90" }, "durationSeconds"],
		[{ ...note, transcript: "Sam: hello" }, "transcript"],
		[
			{ ...note, transcript: [{ speaker: "Sam", startMs: -1, text: "a" }] },
			"transcript.0.startMs",
		],
		[
			{ ...note, transcript: [{ speaker: "Sam", startMs: 1.5, text: "a" }] },
			"transcript.0.startMs",
		],
		[
			{ ...note, transcript: [{ speaker: "Sam", startMs: 0 }] },
			"transcript.0.text",
		],
		[
			{
				...note,
				transcript: [{ speaker: "a".repeat(201), startMs: 0, text: "hello" }],
			},
			"transcript.0.speaker",
		],
		[
			{
				...note,
				transcript: [
					{
						speaker: "Sam",
						startMs: 0,
						text: "a".repeat(MEETING_SHARE_TURN_MAX_CHARS + 1),
					},
				],
			},
			"transcript.0.text",
		],
		[
			{
				...note,
				transcript: Array(MEETING_SHARE_TRANSCRIPT_MAX_TURNS + 1).fill({
					speaker: "Sam",
					startMs: 0,
					text: "a",
				}),
			},
			"transcript",
		],
	])("rejects an out of bounds field %#", (body, field) => {
		expect(rejected(body)).toContain(field);
	});

	it("bounds the transcript as a whole", () => {
		const turn = {
			speaker: "Sam",
			startMs: 0,
			text: "a".repeat(MEETING_SHARE_TURN_MAX_CHARS),
		};
		const turns = MEETING_NOTES_TRANSCRIPT_MAX_CHARS / turn.text.length;

		expect(parse({ ...note, transcript: Array(turns).fill(turn) }).ok).toBe(
			true,
		);
		expect(
			rejected({ ...note, transcript: Array(turns + 1).fill(turn) }),
		).toContain("transcript");
	});

	it("counts title characters, not UTF-16 units", () => {
		expect(
			parse({ ...note, title: "🎥".repeat(MEETING_SHARE_TITLE_MAX_CHARS) }).ok,
		).toBe(true);
	});

	it("never repeats a submitted value in the error", () => {
		const secret = "SECRET-roadmap";

		expect(
			rejected({ ...note, summaryMarkdown: secret, startedAt: secret }),
		).not.toContain(secret);
	});

	it.each(["doc-1", "DOC_1", "a".repeat(64)])(
		"accepts the document id %s",
		(id) => {
			expect(meetingShareDocumentIdSchema.safeParse(id).success).toBe(true);
		},
	);
});
