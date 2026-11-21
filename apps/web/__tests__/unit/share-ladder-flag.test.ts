import { describe, expect, it, vi } from "vitest";
import { createAppFlagReader } from "@/lib/app-flags";
import {
	parseShareLadderFlag,
	SHARE_LADDER_FLAG_OFF,
	shareLadderBucket,
	shareLadderEnabledFor,
} from "@/lib/share-ladder-flag";

describe("parseShareLadderFlag", () => {
	it("is off when the flag is missing or malformed", () => {
		expect(parseShareLadderFlag(null, {})).toEqual(SHARE_LADDER_FLAG_OFF);
		expect(parseShareLadderFlag("on", {})).toEqual(SHARE_LADDER_FLAG_OFF);
		expect(parseShareLadderFlag({ mode: "off" }, {})).toEqual(
			SHARE_LADDER_FLAG_OFF,
		);
		expect(parseShareLadderFlag({ mode: true }, {})).toEqual(
			SHARE_LADDER_FLAG_OFF,
		);
	});

	it("reads an enabled flag and clamps the percentage", () => {
		expect(
			parseShareLadderFlag(
				{ mode: "on", orgIds: ["org1", 4], percent: 150.7, switchOnPause: 1 },
				{},
			),
		).toEqual({
			on: true,
			orgIds: ["org1"],
			percent: 100,
			switchOnPause: false,
		});
		expect(parseShareLadderFlag({ mode: "on", percent: -3 }, {}).percent).toBe(
			0,
		);
	});

	it("is switched off by the environment regardless of the stored value", () => {
		expect(
			parseShareLadderFlag(
				{ mode: "on", percent: 100 },
				{ CAP_SHARE_LADDER: "off" },
			),
		).toEqual(SHARE_LADDER_FLAG_OFF);
	});
});

describe("shareLadderEnabledFor", () => {
	const flag = {
		on: true,
		orgIds: ["internal"],
		percent: 0,
		switchOnPause: false,
	};

	it("enables listed organizations only when the percentage is zero", () => {
		expect(shareLadderEnabledFor(flag, { id: "v1", orgId: "internal" })).toBe(
			true,
		);
		expect(shareLadderEnabledFor(flag, { id: "v1", orgId: "other" })).toBe(
			false,
		);
		expect(shareLadderEnabledFor(flag, { id: "v1", orgId: null })).toBe(false);
	});

	it("never enables anything while the flag is off", () => {
		expect(
			shareLadderEnabledFor(
				{ ...SHARE_LADDER_FLAG_OFF, orgIds: ["internal"], percent: 100 },
				{ id: "v1", orgId: "internal" },
			),
		).toBe(false);
	});

	it("puts each video in a stable bucket for percentage rollouts", () => {
		const ids = Array.from({ length: 2000 }, (_, index) => `video${index}`);
		const enabled = ids.filter((id) =>
			shareLadderEnabledFor({ ...flag, percent: 25 }, { id, orgId: null }),
		).length;
		expect(enabled).toBeGreaterThan(400);
		expect(enabled).toBeLessThan(600);
		expect(shareLadderBucket("abc123")).toBe(shareLadderBucket("abc123"));
		for (const id of ids) {
			expect(
				shareLadderEnabledFor({ ...flag, percent: 100 }, { id, orgId: null }),
			).toBe(true);
		}
	});
});

describe("createAppFlagReader", () => {
	it("caches a value for the cache window", async () => {
		let now = 0;
		const read = vi.fn(async () => ({ mode: "on" }));
		const readFlag = createAppFlagReader(
			{ read },
			{ cacheMs: 1000, now: () => now },
		);
		await readFlag("share_ladder");
		now = 999;
		await readFlag("share_ladder");
		expect(read).toHaveBeenCalledTimes(1);
		now = 1000;
		await readFlag("share_ladder");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("treats a failed read as off and does not cache it", async () => {
		const read = vi
			.fn<(key: string) => Promise<unknown>>()
			.mockRejectedValueOnce(new Error("db down"))
			.mockResolvedValueOnce({ mode: "on" });
		const readFlag = createAppFlagReader({ read }, { now: () => 0 });
		expect(await readFlag("share_ladder")).toBe(null);
		expect(await readFlag("share_ladder")).toEqual({ mode: "on" });
	});
});
