import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	speech: vi.fn(),
}));

vi.mock("@cap/database", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => Object.assign(Promise.resolve(mocks.rows), chain),
		limit: async () => mocks.rows,
		update: () => chain,
		set: () => chain,
		catch: () => chain,
	};
	return { db: () => chain };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraBilling: async () => ({}),
	infraBillingJson: () => ({
		standing: { state: "active", pausesAt: null },
		upload: { allowed: true },
	}),
	infraStorageJson: () => ({ dailyMicroCredits: 0 }),
}));
vi.mock("@/lib/infra-storage", () => ({
	getAppStorageUsage: async () => ({ videoCount: 2, totalMinutes: 12.5 }),
}));
vi.mock("@/lib/developer-transcript-usage", () => ({
	getSpeechUsage: mocks.speech,
}));

import { app } from "@/app/api/developer/v1/[...route]/usage";

beforeEach(() => {
	mocks.rows = [
		{
			appId: "app-1",
			balanceMicroCredits: 1,
			createdVideos: 3,
			uploadedVideos: 2,
			totalDurationMinutes: 12.5,
		},
	];
	mocks.speech.mockReset();
	mocks.speech.mockResolvedValue({
		balanceMicroCredits: 949_286,
		availableMicroCredits: 909_286,
		heldMicroCredits: 40_000,
		speech: {
			periodStart: "2026-11-01T00:00:00.000Z",
			seconds: 18_252.4,
			microCredits: 50_714,
			transcripts: 104,
		},
	});
});

describe("GET /usage", () => {
	it("reports what speech has cost this month, what is held and what is available", async () => {
		const response = await app.request("/", {
			headers: { Authorization: "Bearer csk_valid_key" },
		});

		expect(response.status).toBe(200);
		const { data } = (await response.json()) as {
			data: Record<string, unknown>;
		};
		expect(data).toMatchObject({
			balanceMicroCredits: 949_286,
			availableMicroCredits: 909_286,
			heldMicroCredits: 40_000,
			speech: {
				periodStart: "2026-11-01T00:00:00.000Z",
				seconds: 18_252.4,
				microCredits: 50_714,
				transcripts: 104,
			},
		});
		expect(mocks.speech).toHaveBeenCalledWith("app-1");
	});

	it("keeps every field it returned before", async () => {
		const response = await app.request("/", {
			headers: { Authorization: "Bearer csk_valid_key" },
		});
		const { data } = (await response.json()) as {
			data: Record<string, unknown>;
		};
		expect(Object.keys(data)).toEqual(
			expect.arrayContaining([
				"balanceMicroCredits",
				"balanceDollars",
				"totalVideos",
				"uploadingVideos",
				"totalDurationMinutes",
				"standing",
				"rates",
			]),
		);
		expect(data.balanceDollars).toBe("9.49286");
	});
});
