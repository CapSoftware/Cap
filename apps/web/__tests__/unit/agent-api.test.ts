import { Agent, Video } from "@cap/web-domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	agentCapabilities,
	agentStatus,
	agentTranscriptRevision,
	decodeAgentCursor,
	encodeAgentCursor,
	escapeAgentLikePattern,
	isAgentHttpUrl,
	parseAgentDate,
	parseAgentLimit,
	parseAgentVtt,
	renderAgentVtt,
	safeDownloadFileName,
	transcriptTextFromCues,
} from "@/lib/agent-api";
import { makeSyntheticVtt, syntheticAgentCaps } from "../fixtures/agent-caps";

describe("agent API normalization", () => {
	it("pins pagination defaults and opaque cursor round trips", () => {
		expect(parseAgentLimit(undefined)).toBe(50);
		expect(parseAgentLimit("250")).toBe(100);
		expect(parseAgentLimit("0")).toBeNull();
		expect(parseAgentLimit("nope")).toBeNull();

		const cursor = {
			updatedAt: "2026-07-18T12:00:00.000Z",
			id: "cap_synthetic_1",
		};
		expect(decodeAgentCursor(encodeAgentCursor(cursor))).toEqual(cursor);
		expect(decodeAgentCursor("not-a-cursor")).toBeUndefined();
		expect(decodeAgentCursor("a".repeat(1_025))).toBeUndefined();
		expect(
			decodeAgentCursor(
				Buffer.from(
					JSON.stringify({ updatedAt: cursor.updatedAt, id: "bad id" }),
				).toString("base64url"),
			),
		).toBeUndefined();
	});

	it("accepts only valid ISO-compatible updated-after values", () => {
		expect(parseAgentDate(undefined)).toBeNull();
		expect(parseAgentDate("2026-07-18T12:00:00Z")?.toISOString()).toBe(
			"2026-07-18T12:00:00.000Z",
		);
		expect(parseAgentDate("not-a-date")).toBeUndefined();
		expect(parseAgentDate("2026-07-18T13:00:00+01:00")).toBeUndefined();
		expect(parseAgentDate("2026-02-30T12:00:00Z")).toBeUndefined();
	});

	it("escapes SQL LIKE metacharacters in literal searches", () => {
		expect(escapeAgentLikePattern("100%_ready!")).toBe("100!%!_ready!!");
	});

	it("accepts only absolute HTTP developer logo URLs", () => {
		expect(isAgentHttpUrl("https://cdn.example.com/logo.png")).toBe(true);
		expect(isAgentHttpUrl("http://localhost:3000/logo.png")).toBe(true);
		expect(isAgentHttpUrl("javascript:alert(1)")).toBe(false);
		expect(isAgentHttpUrl("/logo.png")).toBe(false);
	});

	it("normalizes VTT into millisecond cues and text", () => {
		const cues = parseAgentVtt(
			"WEBVTT\r\n\r\n1\r\n00:00:01.250 --> 00:00:03.500 align:start\r\nHello <b>agent</b>\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,125\r\nSecond line\r\n",
		);

		expect(cues).toEqual([
			{ startMs: 1_250, endMs: 3_500, text: "Hello agent" },
			{ startMs: 4_000, endMs: 5_125, text: "Second line" },
		]);
		expect(transcriptTextFromCues(cues)).toBe("Hello agent\nSecond line");
		const rendered = renderAgentVtt(cues);
		expect(parseAgentVtt(rendered)).toEqual(cues);
		expect(agentTranscriptRevision(rendered)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("removes complete and unterminated VTT tags", () => {
		const cues = parseAgentVtt(
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nSafe <script>alert(1)</script> text\n\n2\n00:00:01.000 --> 00:00:02.000\nBefore <script\n",
		);

		expect(cues).toEqual([
			{ startMs: 0, endMs: 1_000, text: "Safe alert(1) text" },
			{ startMs: 1_000, endMs: 2_000, text: "Before" },
		]);
	});

	it("handles representative and large synthetic transcript shapes", () => {
		for (const bytes of [10_000, 100_000, 500_000]) {
			const vtt = makeSyntheticVtt(bytes);
			expect(vtt.length).toBeGreaterThanOrEqual(bytes);
			expect(parseAgentVtt(vtt).length).toBeGreaterThan(0);
		}
	});

	it("reports content and mutation capabilities without inference", () => {
		const capabilities = agentCapabilities({
			isOwner: false,
			hasReadScope: true,
			hasCommentScope: true,
			hasWriteScope: true,
			hasProcessScope: true,
			hasDeleteScope: true,
			passwordRequired: false,
			transcriptStatus: "COMPLETE",
			hasSummary: true,
			hasChapters: true,
			settings: {
				disableSummary: false,
				disableChapters: false,
				disableTranscript: true,
				disableComments: false,
				disableReactions: true,
			},
		});

		expect(capabilities.transcript).toEqual({
			allowed: false,
			reason: "CONTENT_DISABLED",
		});
		expect(capabilities.editTitle).toEqual({
			allowed: false,
			reason: "OWNER_ONLY",
		});
		expect(capabilities.comment.allowed).toBe(true);
		expect(capabilities.react.reason).toBe("CONTENT_DISABLED");
		expect(
			Schema.decodeUnknownSync(Agent.AgentCapabilities)(capabilities),
		).toEqual(capabilities);
	});

	it("locks every read and write surface for protected shared Caps", () => {
		const capabilities = agentCapabilities({
			isOwner: false,
			hasReadScope: true,
			hasCommentScope: true,
			hasWriteScope: true,
			hasProcessScope: true,
			hasDeleteScope: true,
			passwordRequired: true,
			transcriptStatus: "COMPLETE",
			hasSummary: true,
			hasChapters: true,
			settings: {
				disableSummary: false,
				disableChapters: false,
				disableTranscript: false,
				disableComments: false,
				disableReactions: false,
			},
		});

		for (const value of Object.values(capabilities)) {
			expect(value).toEqual({
				allowed: false,
				reason: "PASSWORD_REQUIRED",
			});
		}
	});

	it("maps processing states without starting work", () => {
		const fixture = syntheticAgentCaps.find(
			(cap) => cap.name === "space-share",
		);
		expect(fixture).toBeDefined();
		const status = agentStatus({
			id: Video.VideoId.make("cap_synthetic_processing"),
			updatedAt: new Date("2026-07-18T12:00:00.000Z"),
			transcriptionStatus: fixture?.transcriptionStatus ?? null,
			aiGenerationStatus: fixture?.aiGenerationStatus,
			uploadPhase: "complete",
			uploadError: null,
		});

		expect(status.overall).toBe("processing");
		expect(status.transcript.status).toBe("processing");
		expect(status.ai.status).toBe("queued");
	});

	it("creates portable download names", () => {
		expect(safeDownloadFileName("  Q3: Roadmap / review?  ")).toBe(
			"Q3-Roadmap-review.mp4",
		);
		expect(safeDownloadFileName("🔥")).toBe("cap-recording.mp4");
	});
});
