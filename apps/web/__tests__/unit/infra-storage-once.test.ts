import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@cap/database", () => ({ db: () => holder.db }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "row",
	nanoIdLength: 15,
}));

import { fakeDb, ledger, resetLedger } from "./infra-billing-fake-db";

holder.db = fakeDb;

import {
	billableVideo,
	firstMonthStorageMicroCredits,
} from "@/lib/developer-pricing";
import { getInfraBilling, infraBillingJson } from "@/lib/infra-standing";
import { getAppStorage, getAppStorageUsage } from "@/lib/infra-storage";

const newVideo = billableVideo({
	duration: 900,
	width: 3840,
	height: 2160,
	maxResolutionTier: "2160p",
});

const videoReads = (select: { mock: { results: { value: unknown }[] } }) =>
	select.mock.results.length;

beforeEach(() => {
	resetLedger();
	ledger.account.balanceMicroCredits = 40_000;
	ledger.videos = [
		{
			videoId: "v1",
			appId: "app-1",
			width: 1280,
			height: 720,
			seconds: 61.5,
			count: 3,
		},
		{
			videoId: "v2",
			appId: "app-1",
			width: 2560,
			height: 1440,
			seconds: 600.25,
			count: 2,
		},
		{
			videoId: "v3",
			appId: "app-1",
			width: 3840,
			height: 2160,
			seconds: 1234.125,
			count: 1,
			maxResolutionTier: "1080p",
		},
		{
			videoId: "v4",
			appId: "app-1",
			width: 1920,
			height: 1080,
			seconds: 300,
			count: 4,
			status: "processing",
		},
		{
			videoId: "v5",
			appId: "app-1",
			width: 1920,
			height: 1080,
			seconds: 77,
			count: 1,
			status: "error",
		},
	];
});

describe("one read of stored video serves both totals", () => {
	it("gives the same stored, daily and first month totals as separate reads", async () => {
		for (const [video, options] of [
			[undefined, {}],
			[newVideo, {}],
			[newVideo, { excludeVideoId: "v2" }],
			[undefined, { excludeVideoId: "v4" }],
		] as const) {
			const storage = await getAppStorage("app-1", video, undefined, options);

			expect(storage.stored).toEqual(
				await getAppStorageUsage("app-1", undefined, undefined, options),
			);
			expect(storage.dailyCharge).toEqual(
				await getAppStorageUsage("app-1", undefined, undefined, {
					...options,
					dailyChargeAt: new Date(ledger.now),
				}),
			);
			expect(storage.firstMonthMicroCredits).toBe(
				(options.excludeVideoId === "v4" ? 0 : 425) +
					(video ? firstMonthStorageMicroCredits(video) : 0),
			);
		}
	});

	it("keeps processing video out of what is shown as stored and in what admission counts", async () => {
		const { stored, firstMonthMicroCredits } = await getAppStorage("app-1");

		expect(stored.videoCount).toBe(6);
		expect(firstMonthMicroCredits).toBe(5 * 85);
	});

	it("reads video once for billing and returns what the pages show", async () => {
		const now = new Date(ledger.now);
		const select = vi.spyOn(fakeDb, "select");
		const onVideos = () =>
			select.mock.calls.filter(([fields]) => "seconds" in fields).length;

		const billing = await getInfraBilling("app-1", undefined, now);

		expect(onVideos()).toBe(1);
		expect(videoReads(select)).toBeGreaterThan(1);
		select.mockRestore();
		expect(billing.stored).toEqual(await getAppStorageUsage("app-1"));
		expect(billing.storage.dailyCharge).toEqual(
			await getAppStorageUsage("app-1", undefined, undefined, {
				dailyChargeAt: now,
			}),
		);
		expect(infraBillingJson(billing).storage.minutesByTier).toEqual(
			billing.stored.minutesByTier,
		);
	});
});
