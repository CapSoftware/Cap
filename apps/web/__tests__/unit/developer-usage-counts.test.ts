import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredVideo = {
	status: "uploading" | "processing" | "ready" | "errored";
	duration: number | null;
	width?: number | null;
	height?: number | null;
	maxResolutionTier?: string | null;
};

const mocks = vi.hoisted(() => ({
	balanceMicroCredits: 0,
	videos: [] as StoredVideo[],
	billing: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const rowsFor = (table: unknown, fields?: Record<string, unknown>) => {
		if (table === schema.developerApiKeys) return [{ appId: "app-1" }];
		if (table === schema.developerCreditAccounts) {
			return [{ balanceMicroCredits: mocks.balanceMicroCredits }];
		}
		if (table !== schema.developerVideos) return [];
		if (fields && "createdVideos" in fields) {
			return [
				{
					createdVideos: mocks.videos.length,
					uploadedVideos: mocks.videos.filter(
						(video) => video.duration !== null,
					).length,
					totalDurationMinutes:
						mocks.videos.reduce(
							(sum, video) => sum + (video.duration ?? 0),
							0,
						) / 60,
				},
			];
		}
		return mocks.videos
			.filter((video) => video.duration !== null)
			.map((video) => ({
				appId: "app-1",
				width: video.width ?? 1920,
				height: video.height ?? 1080,
				status: video.status,
				maxResolutionTier: video.maxResolutionTier ?? "1080p",
				seconds: video.duration,
				count: 1,
			}));
	};
	const select = (fields?: Record<string, unknown>) => ({
		from: (table: unknown) => {
			const where = () => {
				const rows = Promise.resolve(rowsFor(table, fields));
				const result = Object.assign(rows, {
					limit: () => result,
					groupBy: () => result,
				});
				return result;
			};
			const query = { innerJoin: () => query, where };
			return query;
		},
	});
	const update = () => ({ set: () => ({ where: async () => {} }) });
	return { db: () => ({ select, update }) };
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
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/infra-standing", async (original) => ({
	...(await original<typeof import("@/lib/infra-standing")>()),
	getInfraBilling: mocks.billing,
}));

import { app } from "@/app/api/developer/v1/[...route]/usage";
import { storageUsage } from "@/lib/developer-pricing";

const usage = async () => {
	const response = await app.request("/", {
		headers: { Authorization: "Bearer csk_usage_key" },
	});
	expect(response.status).toBe(200);
	return (await response.json()).data;
};

beforeEach(() => {
	mocks.balanceMicroCredits = 2_999_901;
	mocks.videos = [];
	mocks.billing.mockResolvedValue({
		standing: { state: "active", pausesAt: null },
		usage: storageUsage([]),
		admission: {
			allowed: true,
			reason: null,
			requiredMicroCredits: 1,
			shortfallMicroCredits: 0,
			message: null,
		},
	});
});

describe("GET /usage totals", () => {
	it("does not count a video that was refused after its upload", async () => {
		mocks.balanceMicroCredits = 967;
		mocks.videos = [{ status: "errored", duration: 345.21 }];

		const data = await usage();

		expect(data).toMatchObject({
			totalVideos: 0,
			totalDurationMinutes: 0,
			uploadingVideos: 0,
			storage: {
				minutesByTier: { "1080p": 0, "1440p": 0, "2160p": 0 },
				dailyMicroCredits: 0,
				monthlyMicroCredits: 0,
			},
		});
	});

	it("counts only what is stored, and agrees with its own tier breakdown", async () => {
		mocks.videos = [
			{ status: "ready", duration: 600 },
			{ status: "ready", duration: 300, width: 3840, height: 2160 },
			{
				status: "ready",
				duration: 120,
				width: 3840,
				height: 2160,
				maxResolutionTier: "2160p",
			},
			{ status: "errored", duration: 3300 },
			{ status: "processing", duration: 900 },
			{ status: "uploading", duration: null },
			{ status: "uploading", duration: null },
		];

		const data = await usage();

		expect(data.totalVideos).toBe(3);
		expect(data.uploadingVideos).toBe(2);
		expect(data.totalDurationMinutes).toBe(17);
		expect(data.storage.minutesByTier).toEqual({
			"1080p": 15,
			"1440p": 0,
			"2160p": 2,
		});
		expect(
			Object.values(
				data.storage.minutesByTier as Record<string, number>,
			).reduce((sum, minutes) => sum + minutes, 0),
		).toBe(data.totalDurationMinutes);
		expect(data.storage.monthlyMicroCredits).toBe(15 * 85 + 2 * 280);
		expect(data.storage.dailyMicroCredits).toBe(
			Math.floor((15 * 85 + 2 * 280) / 30),
		);
	});

	it("reports zero for an app that stores nothing", async () => {
		const data = await usage();

		expect(data).toMatchObject({
			totalVideos: 0,
			uploadingVideos: 0,
			totalDurationMinutes: 0,
		});
	});
});

describe("GET /usage balance", () => {
	it.each([
		[2_999_901, "29.99901"],
		[967, "0.00967"],
		[1_000, "0.01"],
		[3_000_000, "30.00"],
		[0, "0.00"],
	])("writes %i micro-credits as %s dollars", async (balance, dollars) => {
		mocks.balanceMicroCredits = balance;

		const data = await usage();

		expect(data.balanceMicroCredits).toBe(balance);
		expect(data.balanceDollars).toBe(dollars);
		expect(Number(data.balanceDollars) * 100_000).toBeLessThanOrEqual(
			balance + 1e-6,
		);
	});
});
