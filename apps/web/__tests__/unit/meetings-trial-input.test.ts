import { describe, expect, it } from "vitest";
import {
	fitTrialInput,
	MEETING_TRIAL_INPUT_MAX_BYTES,
} from "@/lib/meetings/trial-input";

const bodyBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("fitTrialInput", () => {
	it("leaves a request within the limit alone", () => {
		const input = { transcript: "Speaker 1: hello", question: "q" };
		expect(fitTrialInput(input, bodyBytes(input))).toEqual({
			input,
			truncated: false,
		});
	});

	it("cuts the transcript at a line so the request fits", () => {
		const line = "Speaker 1: we ship on Friday\n";
		const input = { transcript: line.repeat(20), title: "t" };
		const fit = fitTrialInput(input, bodyBytes(input), 300);
		expect(fit?.truncated).toBe(true);
		const rest = bodyBytes(input) - bodyBytes(input.transcript);
		expect(Buffer.byteLength(fit?.input.transcript ?? "")).toBeLessThanOrEqual(
			300 - rest,
		);
		expect(fit?.input.transcript.endsWith("Friday")).toBe(true);
		expect(fit?.input.title).toBe("t");
	});

	it("never splits a character", () => {
		const input = { transcript: "\u{20000}".repeat(1_000) };
		const fit = fitTrialInput(input, bodyBytes(input), 1_001);
		expect(fit?.input.transcript).toBe("\u{20000}".repeat(246));
	});

	it("bounds bytes, not characters", () => {
		const input = { transcript: "\uE000".repeat(200_000) };
		const fit = fitTrialInput(input, bodyBytes(input));
		expect(Buffer.byteLength(fit?.input.transcript ?? "")).toBeLessThanOrEqual(
			MEETING_TRIAL_INPUT_MAX_BYTES,
		);
	});

	it("refuses when the rest of the request is over the limit", () => {
		const input = { transcript: "a", notesMarkdown: "x".repeat(400) };
		expect(fitTrialInput(input, bodyBytes(input), 300)).toBeNull();
	});
});
