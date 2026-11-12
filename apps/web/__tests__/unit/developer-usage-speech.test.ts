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
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerTranscripts,
				() => ({
					status: "complete",
					sourceType: "upload",
					durationSeconds: null,
					reservedMicroCredits: 0,
					billedMicroCredits: 0,
					completedAt: null,
					deletedAt: null,
				}),
			],
		]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "id",
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/developer-transcribe", () => ({
	developerTranscribeWorkflow: "workflow",
}));
vi.mock("@/lib/developer-transcript-speech", () => ({
	isSpeechConfigured: () => true,
	parseTranscriptLanguage: () => "auto",
}));
vi.mock("@/lib/developer-transcript-storage", () => ({}));

import {
	developerCreditAccounts,
	developerTranscripts,
} from "@cap/database/schema";
import { getSpeechUsage } from "@/lib/developer-transcript-usage";

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};

const NOW = new Date("2026-11-12T15:30:00.000Z");

const seed = (id: string, row: Record<string, unknown>) =>
	fake().seed(developerTranscripts, { id, appId: "app-1", ...row });

beforeEach(() => {
	fake().reset();
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 949_286,
	});
});

describe("speech usage for an app", () => {
	it("is empty for an app that has transcribed nothing this month", async () => {
		expect(await getSpeechUsage("app-1", NOW)).toEqual({
			balanceMicroCredits: 949_286,
			availableMicroCredits: 949_286,
			heldMicroCredits: 0,
			speech: {
				periodStart: "2026-11-01T00:00:00.000Z",
				seconds: 0,
				microCredits: 0,
				transcripts: 0,
			},
		});
	});

	it("counts transcripts completed since the first of the month in UTC", async () => {
		seed("last-month", {
			durationSeconds: 3600,
			billedMicroCredits: 10_000,
			completedAt: new Date("2026-10-31T23:59:59.000Z"),
		});
		seed("first-second", {
			durationSeconds: 300.096,
			billedMicroCredits: 833,
			completedAt: new Date("2026-11-01T00:00:00.000Z"),
		});
		seed("this-month", {
			durationSeconds: 1800.07,
			billedMicroCredits: 5_000,
			completedAt: new Date("2026-11-12T14:00:00.000Z"),
		});

		const usage = await getSpeechUsage("app-1", NOW);

		expect(usage.speech).toEqual({
			periodStart: "2026-11-01T00:00:00.000Z",
			seconds: 2100.166,
			microCredits: 5_833,
			transcripts: 2,
		});
	});

	it("keeps a deleted transcript in the total and leaves failed and other apps' out", async () => {
		seed("deleted", {
			durationSeconds: 60,
			billedMicroCredits: 166,
			completedAt: new Date("2026-11-05T10:00:00.000Z"),
			deletedAt: new Date("2026-11-05T11:00:00.000Z"),
		});
		seed("failed", {
			status: "error",
			durationSeconds: 7200,
			billedMicroCredits: 0,
			completedAt: new Date("2026-11-05T10:00:00.000Z"),
		});
		fake().seed(developerTranscripts, {
			id: "other-app",
			appId: "app-2",
			durationSeconds: 999,
			billedMicroCredits: 2_775,
			completedAt: new Date("2026-11-05T10:00:00.000Z"),
		});

		expect((await getSpeechUsage("app-1", NOW)).speech).toMatchObject({
			seconds: 60,
			microCredits: 166,
			transcripts: 1,
		});
	});

	it("reports credit held by running transcripts and what is left available", async () => {
		seed("running-a", {
			status: "processing",
			reservedMicroCredits: 40_000,
		});
		seed("running-b", {
			status: "processing",
			reservedMicroCredits: 5_000,
		});
		seed("failed-with-stale-hold", {
			status: "error",
			reservedMicroCredits: 40_000,
		});
		seed("deleted-while-running", {
			status: "processing",
			reservedMicroCredits: 40_000,
			deletedAt: new Date("2026-11-12T15:00:00.000Z"),
		});

		const usage = await getSpeechUsage("app-1", NOW);

		expect(usage.heldMicroCredits).toBe(45_000);
		expect(usage.balanceMicroCredits).toBe(949_286);
		expect(usage.availableMicroCredits).toBe(949_286 - 45_000);
		expect(usage.speech.microCredits).toBe(0);
	});

	it("reports nothing available for an app with no credit account", async () => {
		expect(await getSpeechUsage("app-without-account", NOW)).toMatchObject({
			balanceMicroCredits: 0,
			availableMicroCredits: 0,
			heldMicroCredits: 0,
		});
	});
});
