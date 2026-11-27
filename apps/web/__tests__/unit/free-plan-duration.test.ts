import type { Organisation, User, Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	serverEnv: {
		CAP_FREE_PLAN_DESKTOP_LIMIT_FROM: undefined as string | undefined,
	},
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	rows: [] as unknown[][],
	queries: 0,
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
	return { db: () => ({ select: () => query }) };
});

import {
	exceedsFreePlanMeasuredDuration,
	FREE_PLAN_MAX_MEASURED_SECONDS,
	FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM,
	getFreePlanDurationLimit,
	hasProPlan,
	isFreePlanDurationError,
	measuredMediaSeconds,
	recordingLimitStillApplies,
} from "@/lib/free-plan-duration";

const free = {
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
};
const pro = {
	stripeSubscriptionStatus: "active",
	thirdPartyStripeSubscriptionId: null,
};

const video = (overrides: Record<string, unknown> = {}) => ({
	id: "video-1" as Video.VideoId,
	ownerId: "owner-1" as User.UserId,
	orgId: "org-1" as Organisation.OrganisationId,
	source: { type: "webMP4" },
	createdAt: new Date(FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM.getTime() + 1),
	metadata: null,
	...overrides,
});

describe("free plan measured duration", () => {
	beforeEach(() => {
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		mocks.rows = [];
		mocks.queries = 0;
	});

	it("allows five minutes plus the finalize grace", () => {
		expect(FREE_PLAN_MAX_MEASURED_SECONDS).toBe(330);
		expect(exceedsFreePlanMeasuredDuration(300)).toBe(false);
		expect(exceedsFreePlanMeasuredDuration(330)).toBe(false);
		expect(exceedsFreePlanMeasuredDuration(330.001)).toBe(true);
		expect(exceedsFreePlanMeasuredDuration(null)).toBe(false);
	});

	it("counts the longer of the header and the measured timestamps", () => {
		expect(measuredMediaSeconds({ duration: 200, timestampSpan: 400 })).toBe(
			400,
		);
		expect(measuredMediaSeconds({ duration: 400, timestampSpan: 200 })).toBe(
			400,
		);
		expect(measuredMediaSeconds({ duration: 0, timestampSpan: 360 })).toBe(360);
		expect(measuredMediaSeconds({ duration: 299, timestampSpan: null })).toBe(
			299,
		);
		expect(
			measuredMediaSeconds({ duration: Number.NaN, timestampSpan: -1 }),
		).toBeNull();
		expect(measuredMediaSeconds(undefined)).toBeNull();
	});

	it("recognises only its own processing error", () => {
		expect(
			isFreePlanDurationError("free-plan-duration-exceeded: Recording exceeds"),
		).toBe(true);
		expect(isFreePlanDurationError("media-input-rejected: not media")).toBe(
			false,
		);
		expect(isFreePlanDurationError(null)).toBe(false);
	});

	it("matches userIsPro for every plan state", async () => {
		const { userIsPro } = await import("@cap/utils");
		for (const user of [
			null,
			free,
			pro,
			{ stripeSubscriptionStatus: "trialing" },
			{ stripeSubscriptionStatus: "past_due" },
			{ stripeSubscriptionStatus: "complete" },
			{ stripeSubscriptionStatus: "paid" },
			{ stripeSubscriptionStatus: "canceled" },
			{ stripeSubscriptionStatus: "unpaid" },
			{ thirdPartyStripeSubscriptionId: "sub_seat" },
		]) {
			expect(hasProPlan(user)).toBe(userIsPro(user));
		}
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		expect(hasProPlan(free)).toBe(true);
		expect(userIsPro(free)).toBe(true);
	});

	it("limits a free plan upload whose owner and organization owner are free", async () => {
		mocks.rows = [[free], [free], []];
		await expect(getFreePlanDurationLimit(video())).resolves.toBe(330);
		expect(mocks.queries).toBe(3);
	});

	it("never limits a Pro owner and asks nothing more", async () => {
		mocks.rows = [[pro]];
		await expect(getFreePlanDurationLimit(video())).resolves.toBeNull();
		expect(mocks.queries).toBe(1);
	});

	it("never limits an organization pro seat", async () => {
		mocks.rows = [[{ ...free, thirdPartyStripeSubscriptionId: "sub_seat" }]];
		await expect(getFreePlanDurationLimit(video())).resolves.toBeNull();
	});

	it("never limits videos in an organization whose owner is Pro", async () => {
		mocks.rows = [[free], [pro]];
		await expect(getFreePlanDurationLimit(video())).resolves.toBeNull();
	});

	it("never limits imported videos", async () => {
		mocks.rows = [[free], [free], [{ id: "video-1" }]];
		await expect(getFreePlanDurationLimit(video())).resolves.toBeNull();
	});

	const beforeCutoff = new Date(
		FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM.getTime() - 1,
	);

	it("limits every source type it processes", async () => {
		mocks.rows = [[free], [free], []];
		await expect(
			getFreePlanDurationLimit(video({ source: { type: "desktopMP4" } })),
		).resolves.toBe(330);
	});

	it("limits desktop pipeline recordings only from the desktop limit date", async () => {
		const pipeline = video({ source: { type: "desktopSegments" } });
		await expect(getFreePlanDurationLimit(pipeline)).resolves.toBeNull();
		expect(mocks.queries).toBe(0);

		mocks.serverEnv.CAP_FREE_PLAN_DESKTOP_LIMIT_FROM = new Date(
			pipeline.createdAt.getTime() + 1,
		).toISOString();
		await expect(getFreePlanDurationLimit(pipeline)).resolves.toBeNull();

		mocks.serverEnv.CAP_FREE_PLAN_DESKTOP_LIMIT_FROM =
			pipeline.createdAt.toISOString();
		mocks.rows = [[free], [free], []];
		await expect(getFreePlanDurationLimit(pipeline)).resolves.toBe(330);
		mocks.serverEnv.CAP_FREE_PLAN_DESKTOP_LIMIT_FROM = undefined;
	});

	it("leaves an older video alone unless its upload is new", async () => {
		mocks.rows = [[{ startedAt: beforeCutoff }]];
		await expect(
			getFreePlanDurationLimit(video({ createdAt: beforeCutoff })),
		).resolves.toBeNull();
		expect(mocks.queries).toBe(1);

		mocks.rows = [[]];
		await expect(
			getFreePlanDurationLimit(video({ createdAt: beforeCutoff })),
		).resolves.toBeNull();

		mocks.rows = [
			[{ startedAt: FREE_PLAN_MEASURED_DURATION_ENFORCED_FROM }],
			[free],
			[free],
			[],
		];
		await expect(
			getFreePlanDurationLimit(video({ createdAt: beforeCutoff })),
		).resolves.toBe(330);
	});

	it.each([
		["self-hosted deployments", {}, undefined],
		[
			"Loom originals",
			{
				metadata: {
					loomDeferredProcessing: { rawFileKey: "k", status: "started" },
				},
			},
			"true",
		],
	])("never limits %s, without a query", async (_, overrides, isCap) => {
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = isCap;
		await expect(
			getFreePlanDurationLimit(video(overrides)),
		).resolves.toBeNull();
		expect(mocks.queries).toBe(0);
	});
});

describe("recording limit check during a recording", () => {
	beforeEach(() => {
		mocks.rows = [];
		mocks.queries = 0;
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
	});

	const recording = { ownerId: "owner-1", orgId: "org-1" };

	it("still applies while the owner and the organization are free", async () => {
		mocks.rows = [[recording], [free], [free]];
		expect(
			await recordingLimitStillApplies("owner-1" as User.UserId, "video-1"),
		).toBe(true);
	});

	it("lifts when the organization's owner has Pro", async () => {
		mocks.rows = [[recording], [free], [pro]];
		expect(
			await recordingLimitStillApplies("owner-1" as User.UserId, "video-1"),
		).toBe(false);
	});

	it("lifts when the recording's owner has Pro", async () => {
		mocks.rows = [[recording], [pro]];
		expect(
			await recordingLimitStillApplies("owner-1" as User.UserId, "video-1"),
		).toBe(false);
	});

	it("answers nothing for a recording that is not the user's", async () => {
		mocks.rows = [[]];
		expect(
			await recordingLimitStillApplies("owner-2" as User.UserId, "video-1"),
		).toBeUndefined();
		expect(mocks.queries).toBe(1);
	});
});
