import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		reset: () => void;
	},
}));

vi.mock("@cap/database", async () => {
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(new Map());
	context.fake = fake;
	return { db: () => fake.db };
});

import { developerTranscripts } from "@cap/database/schema";
import {
	claimTranscriptRun,
	failTranscriptRun,
} from "@/lib/developer-transcript-run";

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const row = () => fake().rows(developerTranscripts)[0];
const seed = (overrides: Record<string, unknown> = {}) =>
	fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		status: "queued",
		runId: "run-a",
		deletedAt: null,
		reservedMicroCredits: 500,
		errorCode: null,
		...overrides,
	});

beforeEach(() => fake().reset());

describe("claiming a transcript run", () => {
	it("lets the dispatched run claim the transcript", async () => {
		seed();
		expect(await claimTranscriptRun("tr-1", "run-a")).toBe(true);
		expect(row()?.status).toBe("processing");
	});

	it("stays claimed when the same run repeats its claim step", async () => {
		seed();
		await claimTranscriptRun("tr-1", "run-a");
		expect(await claimTranscriptRun("tr-1", "run-a")).toBe(true);
	});

	it("refuses an older run once the transcript was dispatched again", async () => {
		seed({ runId: "run-b" });
		expect(await claimTranscriptRun("tr-1", "run-a")).toBe(false);
		expect(row()?.status).toBe("queued");
		expect(await claimTranscriptRun("tr-1", "run-b")).toBe(true);
	});

	it("lets only one of two runs proceed", async () => {
		seed({ runId: "run-b" });
		const results = await Promise.all([
			claimTranscriptRun("tr-1", "run-a"),
			claimTranscriptRun("tr-1", "run-b"),
		]);
		expect(results).toEqual([false, true]);
	});

	it("refuses a second run while another one is processing", async () => {
		seed({ status: "processing", runId: "run-a" });
		expect(await claimTranscriptRun("tr-1", "run-b")).toBe(false);
		expect(row()).toMatchObject({ status: "processing", runId: "run-a" });
	});

	it.each([
		["a deleted transcript", { deletedAt: new Date() }],
		["a finished transcript", { status: "complete" }],
		["a failed transcript", { status: "error" }],
		["an upload that was never started", { status: "uploading", runId: null }],
	])("refuses %s", async (_label, overrides) => {
		seed(overrides);
		expect(await claimTranscriptRun("tr-1", "run-a")).toBe(false);
	});

	it("refuses a transcript that does not exist", async () => {
		expect(await claimTranscriptRun("tr-missing", "run-a")).toBe(false);
	});
});

describe("failing a transcript run", () => {
	it("marks its own transcript failed and releases the hold", async () => {
		seed({ status: "processing" });
		const result = await failTranscriptRun(
			"tr-1",
			"run-a",
			"no_speech",
			"No speech was found in the audio",
		);
		expect(result).toEqual({ failed: true, appId: "app-1" });
		expect(row()).toMatchObject({
			status: "error",
			errorCode: "no_speech",
			reservedMicroCredits: 0,
		});
	});

	it("reports the same outcome when the step repeats", async () => {
		seed({ status: "processing" });
		await failTranscriptRun("tr-1", "run-a", "no_speech", "first");
		const again = await failTranscriptRun("tr-1", "run-a", "timed_out", "x");
		expect(again.failed).toBe(true);
		expect(row()?.errorCode).toBe("no_speech");
	});

	it("cannot fail a transcript that another run owns", async () => {
		seed({ status: "processing", runId: "run-b" });
		const result = await failTranscriptRun(
			"tr-1",
			"run-a",
			"transcription_failed",
			"x",
		);
		expect(result.failed).toBe(false);
		expect(row()).toMatchObject({
			status: "processing",
			errorCode: null,
			reservedMicroCredits: 500,
		});
	});

	it("leaves a completed transcript alone", async () => {
		seed({ status: "complete" });
		const result = await failTranscriptRun(
			"tr-1",
			"run-a",
			"transcription_failed",
			"x",
		);
		expect(result.failed).toBe(false);
		expect(row()?.status).toBe("complete");
	});

	it("truncates a long message", async () => {
		seed({ status: "processing" });
		await failTranscriptRun(
			"tr-1",
			"run-a",
			"source_unreachable",
			"m".repeat(900),
		);
		expect(String(row()?.errorMessage)).toHaveLength(512);
	});
});
