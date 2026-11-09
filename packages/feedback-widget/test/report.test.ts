import { afterEach, describe, expect, it } from "vitest";
import { createCollector } from "../src/evidence";
import {
	buildEvidence,
	contextIds,
	postHogIds,
	reportForm,
} from "../src/report";
import { baseType, pickAudioType } from "../src/voice";

describe("context", () => {
	it("keeps ids only", () => {
		expect(
			contextIds({
				userId: "user_123",
				orgId: 42,
				release: "2026.11.09+abc",
				...({ email: "pat@example.com", name: "Pat" } as object),
			}),
		).toEqual({ userId: "user_123", orgId: "42", release: "2026.11.09+abc" });
		expect(contextIds({ userId: "Pat Smith <pat@example.com>" })).toEqual({});
		expect(contextIds(undefined)).toEqual({});
	});
});

describe("PostHog", () => {
	it("stores the session id and https replay link", () => {
		expect(
			postHogIds({
				get_session_id: () => "0192-session",
				get_session_replay_url: () =>
					"https://us.posthog.com/project/1/replay/0192-session?t=10",
			}),
		).toEqual({
			sessionId: "0192-session",
			replayUrl: "https://us.posthog.com/project/1/replay/0192-session?t=10",
		});
	});

	it("tolerates a missing or failing instance", () => {
		expect(postHogIds(undefined)).toBeUndefined();
		expect(
			postHogIds({
				get_session_id: () => {
					throw new Error("not loaded");
				},
				get_session_replay_url: () => "javascript:alert(1)",
			}),
		).toBeUndefined();
	});
});

describe("report", () => {
	let stop = () => {};
	afterEach(() => stop());

	it("builds evidence without query strings and a bounded form", async () => {
		history.replaceState(null, "", "/patients/123456?mrn=9");
		const collector = createCollector({
			host: () => null,
			ignoreOrigin: "https://feedback-server.test",
		});
		stop = collector.stop;
		const evidence = await buildEvidence(collector, {
			getContext: () => ({ userId: "u1" }),
			posthog: { get_session_id: () => "s1" },
		});
		expect(evidence).toMatchObject({
			schemaVersion: 1,
			route: "/patients/:id",
			context: { userId: "u1" },
			posthog: { sessionId: "s1" },
		});
		const form = reportForm({
			siteKey: "wf_pub_demo",
			note: "x".repeat(5000),
			evidence,
			screenshot: new Blob(["jpeg"], { type: "image/jpeg" }),
			voice: {
				blob: new Blob(["a"], { type: "audio/mp4" }),
				mimeType: "audio/mp4",
				durationMs: 1000,
				startedAt: 1,
			},
		});
		expect(form.get("key")).toBe("wf_pub_demo");
		expect(String(form.get("note"))).toHaveLength(4000);
		expect((form.get("screenshot") as File).name).toBe("screenshot.jpg");
		expect((form.get("voice") as File).name).toBe("voice.m4a");
		expect(JSON.parse(String(form.get("evidence"))).route).toBe(
			"/patients/:id",
		);
	});

	it("survives a failing getContext", async () => {
		const collector = createCollector({
			host: () => null,
			ignoreOrigin: "https://feedback-server.test",
		});
		stop = collector.stop;
		const evidence = await buildEvidence(collector, {
			getContext: () => {
				throw new Error("no user");
			},
		});
		expect(evidence.context).toEqual({});
	});
});

describe("voice formats", () => {
	it("prefers Opus in WebM and falls back to AAC in MP4 for iOS Safari", () => {
		expect(pickAudioType((type) => type.startsWith("audio/webm"))).toBe(
			"audio/webm;codecs=opus",
		);
		expect(pickAudioType((type) => type.startsWith("audio/mp4"))).toBe(
			"audio/mp4;codecs=mp4a.40.2",
		);
		expect(pickAudioType(() => false)).toBe("");
		expect(baseType("audio/mp4;codecs=mp4a.40.2")).toBe("audio/mp4");
	});
});
