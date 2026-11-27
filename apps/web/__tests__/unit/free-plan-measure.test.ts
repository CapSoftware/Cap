import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	serverEnv: {
		CAP_FREE_PLAN_DESKTOP_LIMIT_FROM: undefined as string | undefined,
	},
	rows: [] as unknown[][],
	queries: 0,
	updates: [] as unknown[],
}));

vi.mock("@cap/env", () => ({
	buildEnv: mocks.buildEnv,
	serverEnv: () => mocks.serverEnv,
}));
vi.mock("@cap/database", () => {
	const query = {
		from: () => query,
		innerJoin: () => query,
		where: () => query,
		limit: async () => {
			mocks.queries += 1;
			return mocks.rows.shift() ?? [];
		},
	};
	const update = {
		set: (values: unknown) => {
			mocks.updates.push(values);
			return { where: async () => undefined };
		},
	};
	return { db: () => ({ select: () => query, update: () => update }) };
});

import { FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM } from "@/lib/free-plan-duration";
import {
	isVideoOverFreePlanDuration,
	needsFreePlanMeasure,
	readFreePlanMeasure,
	recordFreePlanMeasure,
	recordFreePlanOverLength,
} from "@/lib/free-plan-measure";

const free = {
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
};
const pro = {
	stripeSubscriptionStatus: "active",
	thirdPartyStripeSubscriptionId: null,
};

const afterCutoff = new Date(
	FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM.getTime() + 1,
);
const beforeCutoff = new Date(
	FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM.getTime() - 1,
);

const measured = (
	seconds: number | null,
	key = "o/v/result.mp4",
	at?: string,
) => ({
	freePlanMeasure: {
		key,
		seconds,
		at: at ?? new Date().toISOString(),
	},
});

const video = (metadata: object | null, overrides: object = {}) => ({
	id: "video-1" as Video.VideoId,
	ownerId: "owner-1" as User.UserId,
	orgId: "org-1" as Organisation.OrganisationId,
	isScreenshot: false,
	source: { type: "webMP4" },
	metadata,
	...overrides,
});

describe("free plan measured lock", () => {
	beforeEach(() => {
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		mocks.serverEnv.CAP_FREE_PLAN_DESKTOP_LIMIT_FROM = undefined;
		mocks.rows = [];
		mocks.queries = 0;
		mocks.updates = [];
	});

	it("reads only well formed measurements", () => {
		expect(readFreePlanMeasure(null)).toBeNull();
		expect(readFreePlanMeasure({ freePlanMeasure: "x" })).toBeNull();
		expect(readFreePlanMeasure({ freePlanMeasure: { key: "k" } })).toBeNull();
		expect(
			readFreePlanMeasure({
				freePlanMeasure: { key: "k", seconds: "400", at: "t" },
			}),
		).toEqual({ key: "k", seconds: null, at: "t" });
	});

	it("never locks without an over-limit measurement and never queries", async () => {
		expect(await isVideoOverFreePlanDuration(video(null))).toBe(false);
		expect(await isVideoOverFreePlanDuration(video(measured(330)))).toBe(false);
		expect(await isVideoOverFreePlanDuration(video(measured(null)))).toBe(
			false,
		);
		expect(mocks.queries).toBe(0);
	});

	it("locks a free video measured over the limit", async () => {
		mocks.rows = [
			[{ source: { type: "webMP4" }, createdAt: afterCutoff }],
			[],
			[free],
			[free],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(331)))).toBe(true);
	});

	it("holds desktop recordings only from the desktop limit date", async () => {
		const desktop = (createdAt: Date) => [
			{ source: { type: "desktopSegments" }, createdAt },
		];
		mocks.rows = [desktop(afterCutoff)];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
		mocks.serverEnv.CAP_FREE_PLAN_DESKTOP_LIMIT_FROM =
			"2026-12-01T00:00:00.000Z";
		mocks.rows = [desktop(new Date("2026-11-30T23:59:59.000Z"))];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
		mocks.rows = [
			desktop(new Date("2026-12-01T00:00:00.000Z")),
			[],
			[free],
			[free],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(true);
	});

	it("exempts only recordings published by the desktop pipeline", async () => {
		const desktopMp4 = (outputKey?: string) => [
			{
				id: "video-1",
				ownerId: "owner-1",
				source: { type: "desktopMP4", outputKey },
				createdAt: afterCutoff,
			},
		];
		mocks.rows = [
			desktopMp4("owner-1/video-1/.recording/outputs/abc/result.mp4"),
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
		mocks.rows = [desktopMp4(), [], [free], [free]];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(true);
		mocks.rows = [
			desktopMp4("owner-2/video-1/.recording/outputs/abc/result.mp4"),
			[],
			[free],
			[free],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(true);
		mocks.rows = [
			[
				{
					id: "video-1",
					ownerId: "owner-1",
					source: { type: "MediaConvert" },
					createdAt: afterCutoff,
				},
			],
			[],
			[free],
			[free],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(true);
	});

	it("unlocks when the owner or the organization owner has Pro", async () => {
		mocks.rows = [
			[{ source: { type: "webMP4" }, createdAt: afterCutoff }],
			[],
			[pro],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
		mocks.rows = [
			[{ source: { type: "webMP4" }, createdAt: afterCutoff }],
			[],
			[free],
			[pro],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
	});

	it("never locks imported videos or self-hosted servers", async () => {
		mocks.rows = [
			[{ source: { type: "webMP4" }, createdAt: afterCutoff }],
			[{ id: "video-1" }],
		];
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		expect(await isVideoOverFreePlanDuration(video(measured(400)))).toBe(false);
	});

	it("locks a video flagged as a screenshot that measures over the limit", async () => {
		mocks.rows = [
			[{ source: { type: "desktopMP4" }, createdAt: afterCutoff }],
			[],
			[free],
			[free],
		];
		expect(
			await isVideoOverFreePlanDuration(
				video(measured(400), { isScreenshot: true }),
			),
		).toBe(true);
	});

	it("measures new videos once per playable object", () => {
		const key = "o/v/result.mp4";
		expect(
			needsFreePlanMeasure({ createdAt: afterCutoff, metadata: null }, key),
		).toBe(true);
		expect(
			needsFreePlanMeasure(
				{ createdAt: afterCutoff, metadata: measured(100, key) },
				key,
			),
		).toBe(false);
		expect(
			needsFreePlanMeasure(
				{ createdAt: afterCutoff, metadata: measured(100, "o/v/other.mp4") },
				key,
			),
		).toBe(true);
	});

	it("leaves older videos alone unless a new upload was signed", () => {
		const key = "o/v/result.mp4";
		expect(
			needsFreePlanMeasure({ createdAt: beforeCutoff, metadata: null }, key),
		).toBe(false);
		const now = Date.now();
		const openUntil = new Date(now + 60_000).toISOString();
		expect(
			needsFreePlanMeasure(
				{
					createdAt: beforeCutoff,
					metadata: { freePlanUploadOpenUntil: openUntil },
				},
				key,
				now,
			),
		).toBe(true);
	});

	it("re-measures while a signed upload can still replace the object", () => {
		const key = "o/v/result.mp4";
		const now = Date.now();
		const openUntil = new Date(now + 600_000).toISOString();
		const metadata = (at: number) => ({
			freePlanUploadOpenUntil: openUntil,
			...measured(100, key, new Date(at).toISOString()),
		});
		expect(
			needsFreePlanMeasure(
				{ createdAt: afterCutoff, metadata: metadata(now - 10_000) },
				key,
				now,
			),
		).toBe(false);
		expect(
			needsFreePlanMeasure(
				{ createdAt: afterCutoff, metadata: metadata(now - 31_000) },
				key,
				now,
			),
		).toBe(true);
		expect(
			needsFreePlanMeasure(
				{
					createdAt: afterCutoff,
					metadata: {
						freePlanUploadOpenUntil: new Date(now - 60_000).toISOString(),
						...measured(100, key, new Date(now - 30_000).toISOString()),
					},
				},
				key,
				now,
			),
		).toBe(false);
	});

	it("records only lengths over the limit for free videos", async () => {
		await recordFreePlanOverLength("video-1" as Video.VideoId, "k", 300);
		expect(mocks.queries).toBe(0);
		expect(mocks.updates).toHaveLength(0);

		mocks.rows = [
			[{ ...video(null), createdAt: afterCutoff }],
			[],
			[free],
			[free],
		];
		await recordFreePlanOverLength("video-1" as Video.VideoId, "k", 400);
		expect(mocks.updates).toHaveLength(1);
	});

	it("records a measurement without marking the Cap as changed, so its views are still counted", async () => {
		await recordFreePlanMeasure("video-1" as Video.VideoId, "k", 400);
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]).toHaveProperty("metadata");
		expect(mocks.updates[0]).toHaveProperty("updatedAt");
	});

	it("does not record for Pro owners and remembers it", async () => {
		mocks.rows = [
			[{ ...video(null), id: "video-2", createdAt: afterCutoff }],
			[],
			[pro],
		];
		await recordFreePlanOverLength("video-2" as Video.VideoId, "k", 400);
		const queries = mocks.queries;
		await recordFreePlanOverLength("video-2" as Video.VideoId, "k", 500);
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.queries).toBe(queries);
	});

	it("does not measure desktop recordings before the desktop limit date", async () => {
		mocks.rows = [
			[
				{
					...video(null),
					id: "video-4",
					source: { type: "desktopSegments" },
					createdAt: afterCutoff,
				},
			],
		];
		await recordFreePlanOverLength("video-4" as Video.VideoId, "k", 400);
		const queries = mocks.queries;
		await recordFreePlanOverLength("video-4" as Video.VideoId, "k", 500);
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.queries).toBe(queries);
	});

	it("records an older video only for a new upload", async () => {
		mocks.rows = [[{ ...video(null), id: "video-3", createdAt: beforeCutoff }]];
		await recordFreePlanOverLength("video-3" as Video.VideoId, "k", 400);
		expect(mocks.updates).toHaveLength(0);

		mocks.rows = [
			[{ ...video(null), id: "video-3", createdAt: beforeCutoff }],
			[],
			[free],
			[free],
		];
		await recordFreePlanOverLength("video-3" as Video.VideoId, "k", 400, {
			anyAge: true,
		});
		expect(mocks.updates).toHaveLength(1);
	});
});
