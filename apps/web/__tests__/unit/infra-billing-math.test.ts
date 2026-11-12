import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/schema", () => ({
	developerCreditAccounts: {},
	developerCreditTransactions: {},
	developerVideos: {},
}));

import {
	billableVideo,
	dailyStorageMicroCredits,
	MICRO_CREDITS_PER_DOLLAR,
	monthlyStorageMicroCredits,
	STORAGE_BILLING_DAYS_PER_MONTH,
	storageMicroCreditsPerMinutePerMonth,
	storageUsage,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
	videoStorageTier,
} from "@/lib/developer-pricing";
import {
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	INFRA_TIER_MAX_PIXELS,
} from "@/lib/infra-pricing";
import {
	INFRA_GRACE_DAYS,
	parseStorageCharge,
	resolveStanding,
	uploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { settleStorageDay } from "@/lib/infra-storage-billing";

const video = (
	seconds: number,
	width: number,
	height: number,
	extra: { status?: string | null; maxResolutionTier?: string | null } = {},
) =>
	billableVideo({
		duration: seconds,
		width,
		height,
		maxResolutionTier: null,
		...extra,
	});

describe("storage tier by pixel count", () => {
	it("keeps 1920x1080 in the 1080p tier and moves one pixel more to 1440p", () => {
		expect(1920 * 1080).toBe(INFRA_TIER_MAX_PIXELS["1080p"]);
		expect(videoStorageTier({ width: 1920, height: 1080 })).toBe("1080p");
		expect(videoStorageTier({ width: 1921, height: 1080 })).toBe("1440p");
	});

	it("keeps 4,194,304 pixels in the 1440p tier and moves one pixel more to 4K", () => {
		expect(2048 * 2048).toBe(INFRA_TIER_MAX_PIXELS["1440p"]);
		expect(videoStorageTier({ width: 2048, height: 2048 })).toBe("1440p");
		expect(videoStorageTier({ width: 2560, height: 1440 })).toBe("1440p");
		expect(videoStorageTier({ width: 2049, height: 2048 })).toBe("2160p");
	});

	it("prices by pixels, not by height or name", () => {
		expect(videoStorageTier({ width: 2560, height: 1080 })).toBe("1440p");
		expect(videoStorageTier({ width: 1080, height: 1920 })).toBe("1080p");
		expect(videoStorageTier({ width: 3840, height: 2160 })).toBe("2160p");
		expect(videoStorageTier({ width: 7680, height: 4320 })).toBe("2160p");
	});

	it("uses the lower of the source tier and the max tier", () => {
		const uhd = { width: 3840, height: 2160 };
		expect(videoStorageTier(uhd, "1080p")).toBe("1080p");
		expect(videoStorageTier(uhd, "1440p")).toBe("1440p");
		expect(videoStorageTier(uhd, "2160p")).toBe("2160p");
		expect(videoStorageTier(uhd, null)).toBe("2160p");
		expect(videoStorageTier({ width: 1280, height: 720 }, "2160p")).toBe(
			"1080p",
		);
	});
});

describe("billable video", () => {
	it("returns the duration, size and tier of a stored video", () => {
		expect(video(90, 2560, 1440)).toEqual({
			durationSeconds: 90,
			width: 2560,
			height: 1440,
			tier: "1440p",
		});
	});

	it("does not bill a video with no duration yet", () => {
		expect(
			billableVideo({
				duration: null,
				width: 1920,
				height: 1080,
				maxResolutionTier: null,
			}),
		).toBe(null);
		expect(video(0, 1920, 1080)).toBe(null);
		expect(video(Number.NaN, 1920, 1080)).toBe(null);
		expect(video(-5, 1920, 1080)).toBe(null);
	});

	it("bills a video with no known size at the lowest tier", () => {
		expect(
			billableVideo({
				duration: 60,
				width: null,
				height: null,
				maxResolutionTier: null,
			})?.tier,
		).toBe("1080p");
	});

	it("bills only ready videos once a status is passed", () => {
		expect(video(60, 1920, 1080, { status: "ready" })?.durationSeconds).toBe(
			60,
		);
		for (const status of ["uploading", "processing", "errored", null]) {
			expect(video(60, 1920, 1080, { status })).toBe(null);
		}
	});

	it("bills a row with no status column as before", () => {
		expect(video(60, 1920, 1080)?.durationSeconds).toBe(60);
	});

	it("caps the tier at the video's max resolution tier and ignores unknown values", () => {
		expect(video(60, 3840, 2160, { maxResolutionTier: "1080p" })?.tier).toBe(
			"1080p",
		);
		expect(video(60, 3840, 2160, { maxResolutionTier: "720p" })?.tier).toBe(
			"2160p",
		);
		expect(video(60, 3840, 2160, { maxResolutionTier: null })?.tier).toBe(
			"2160p",
		);
	});
});

describe("storage rates", () => {
	it("derives the per minute rate from the price card", () => {
		expect(storageMicroCreditsPerMinutePerMonth("1080p")).toBe(85);
		expect(storageMicroCreditsPerMinutePerMonth("1440p")).toBe(145);
		expect(storageMicroCreditsPerMinutePerMonth("2160p")).toBe(280);
	});

	it("charges the card price for 1,000 minutes over a 30 day month", () => {
		for (const tier of ["1080p", "1440p", "2160p"] as const) {
			const minutes = { "1080p": 0, "1440p": 0, "2160p": 0, [tier]: 1000 };
			expect(
				monthlyStorageMicroCredits(minutes) / MICRO_CREDITS_PER_DOLLAR,
			).toBe(INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier]);
			const month =
				dailyStorageMicroCredits(minutes) * STORAGE_BILLING_DAYS_PER_MONTH;
			expect(month / MICRO_CREDITS_PER_DOLLAR).toBeCloseTo(
				INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier],
				3,
			);
		}
	});

	it("pro-rates a day as one thirtieth of the month, rounded down", () => {
		expect(
			dailyStorageMicroCredits({ "1080p": 1000, "1440p": 0, "2160p": 0 }),
		).toBe(2833);
		expect(
			dailyStorageMicroCredits({ "1080p": 0, "1440p": 1000, "2160p": 0 }),
		).toBe(4833);
		expect(
			dailyStorageMicroCredits({ "1080p": 0, "1440p": 0, "2160p": 1000 }),
		).toBe(9333);
	});

	it("adds each video at its own tier", () => {
		const usage = storageUsage([
			{ video: video(60, 1280, 720), count: 1 },
			{ video: video(600, 2560, 1440), count: 1 },
			{ video: video(600, 3840, 2160), count: 1 },
			{ video: video(60, 1920, 1080, { status: "processing" }), count: 4 },
		]);
		expect(usage.minutesByTier).toEqual({
			"1080p": 1,
			"1440p": 10,
			"2160p": 10,
		});
		expect(usage.videoCount).toBe(3);
		expect(usage.totalMinutes).toBe(21);
		expect(usage.monthlyMicroCredits).toBe(85 + 1450 + 2800);
		expect(usage.dailyMicroCredits).toBe(144);
	});

	it("charges nothing for nothing stored", () => {
		expect(storageUsage([]).dailyMicroCredits).toBe(0);
	});
});

describe("upload admission", () => {
	const active = { state: "active" as const, pausesAt: null };

	it("needs seven days of storage, rounded up, and at least one micro-credit", () => {
		expect(UPLOAD_ADMISSION_DAYS).toBe(7);
		expect(uploadAdmissionMicroCredits(0)).toBe(1);
		expect(uploadAdmissionMicroCredits(85_000)).toBe(19_834);
		expect(uploadAdmissionMicroCredits(4335)).toBe(1012);
	});

	it("admits when the balance covers seven days of everything stored", () => {
		const admission = uploadAdmission({
			balanceMicroCredits: 19_834,
			standing: active,
			lastOwedMicroCredits: 0,
			usage: { monthlyMicroCredits: 85_000 },
		});
		expect(admission).toMatchObject({
			allowed: true,
			reason: null,
			message: null,
			requiredMicroCredits: 19_834,
			shortfallMicroCredits: 0,
		});
	});

	it("refuses one micro-credit short and says how much is needed", () => {
		const admission = uploadAdmission({
			balanceMicroCredits: 19_833,
			standing: active,
			lastOwedMicroCredits: 0,
			usage: { monthlyMicroCredits: 85_000 },
		});
		expect(admission.allowed).toBe(false);
		expect(admission.reason).toBe("insufficient_credits");
		expect(admission.shortfallMicroCredits).toBe(1);
		expect(admission.message).toBe(
			"Uploading needs $0.19834 of credit, enough for 7 days of storage for everything this app stores. The balance is $0.19833, so add at least $0.00001.",
		);
	});

	it("names amounts that add up when the balance is under a cent", () => {
		const admission = uploadAdmission({
			balanceMicroCredits: 967,
			standing: active,
			lastOwedMicroCredits: 0,
			usage: { monthlyMicroCredits: 4_675 },
		});
		expect(admission.requiredMicroCredits).toBe(1_091);
		expect(admission.shortfallMicroCredits).toBe(124);
		expect(admission.message).toBe(
			"Uploading needs $0.01091 of credit, enough for 7 days of storage for everything this app stores. The balance is $0.00967, so add at least $0.00124.",
		);
	});

	it("refuses at zero balance even with nothing stored", () => {
		const admission = uploadAdmission({
			balanceMicroCredits: 0,
			standing: active,
			lastOwedMicroCredits: 0,
			usage: { monthlyMicroCredits: 0 },
		});
		expect(admission.allowed).toBe(false);
		expect(admission.reason).toBe("insufficient_credits");
		expect(admission.message).toBe(
			"This app has no credit. Add credits to start uploading.",
		);
	});

	it("refuses an app that is not in good standing whatever its balance", () => {
		for (const state of ["grace", "paused"] as const) {
			const admission = uploadAdmission({
				balanceMicroCredits: 50,
				standing: { state, pausesAt: new Date("2026-11-18T00:00:00Z") },
				lastOwedMicroCredits: 144,
				usage: { monthlyMicroCredits: 4335 },
			});
			expect(admission.allowed).toBe(false);
			expect(admission.reason).toBe("out_of_credit");
			expect(admission.requiredMicroCredits).toBe(1012);
			expect(admission.shortfallMicroCredits).toBe(962);
			expect(admission.message).toBe(
				"This app is out of credit, so uploads are blocked. Add at least $0.00962 to upload again.",
			);
		}
	});

	it("asks for the unpaid day when that is more than seven days of storage", () => {
		const admission = uploadAdmission({
			balanceMicroCredits: 0,
			standing: { state: "grace", pausesAt: new Date() },
			lastOwedMicroCredits: 5000,
			usage: { monthlyMicroCredits: 300 },
		});
		expect(admission.requiredMicroCredits).toBe(5000);
	});

	it("shapes the 402 body with the amounts and the standing", () => {
		const pausesAt = new Date("2026-11-18T00:00:00Z");
		const body = uploadAdmissionError(
			uploadAdmission({
				balanceMicroCredits: 0,
				standing: { state: "grace", pausesAt },
				lastOwedMicroCredits: 144,
				usage: { monthlyMicroCredits: 4335 },
			}),
		);
		expect(body).toMatchObject({
			error: "Insufficient credits",
			code: "out_of_credit",
			standing: "grace",
			pausesAt: pausesAt.toISOString(),
			balanceMicroCredits: 0,
			requiredMicroCredits: 1012,
			shortfallMicroCredits: 1012,
		});
		expect(body.message).toContain("Add at least $0.01012 ");
	});
});

describe("settling a storage day", () => {
	const now = new Date("2026-11-11T06:41:00Z");

	it("charges the full amount when the balance covers it", () => {
		expect(
			settleStorageDay({
				balanceMicroCredits: 1000,
				owedMicroCredits: 144,
				unresolvedShortSince: null,
				now,
			}),
		).toEqual({
			owedMicroCredits: 144,
			chargedMicroCredits: 144,
			balanceMicroCredits: 856,
			shortSince: null,
			fellShort: false,
		});
	});

	it("is not short when the balance is exactly what is owed", () => {
		const settled = settleStorageDay({
			balanceMicroCredits: 144,
			owedMicroCredits: 144,
			unresolvedShortSince: null,
			now,
		});
		expect(settled.balanceMicroCredits).toBe(0);
		expect(settled.shortSince).toBe(null);
	});

	it("takes exactly what is there on a short day and records when it fell short", () => {
		expect(
			settleStorageDay({
				balanceMicroCredits: 50,
				owedMicroCredits: 144,
				unresolvedShortSince: null,
				now,
			}),
		).toEqual({
			owedMicroCredits: 144,
			chargedMicroCredits: 50,
			balanceMicroCredits: 0,
			shortSince: now,
			fellShort: true,
		});
	});

	it("never takes more than what is available when part of the balance is held", () => {
		expect(
			settleStorageDay({
				balanceMicroCredits: 1000,
				availableMicroCredits: 60,
				owedMicroCredits: 144,
				unresolvedShortSince: null,
				now,
			}),
		).toEqual({
			owedMicroCredits: 144,
			chargedMicroCredits: 60,
			balanceMicroCredits: 940,
			shortSince: now,
			fellShort: true,
		});
	});

	it("keeps the first short date on later short days", () => {
		const first = new Date("2026-11-08T06:41:00Z");
		const settled = settleStorageDay({
			balanceMicroCredits: 10,
			owedMicroCredits: 144,
			unresolvedShortSince: first,
			now,
		});
		expect(settled.shortSince).toBe(first);
		expect(settled.fellShort).toBe(false);
		expect(settled.chargedMicroCredits).toBe(10);
	});

	it("clears the short date once a day is paid in full", () => {
		const settled = settleStorageDay({
			balanceMicroCredits: 500,
			owedMicroCredits: 144,
			unresolvedShortSince: new Date("2026-11-08T06:41:00Z"),
			now,
		});
		expect(settled.shortSince).toBe(null);
		expect(settled.chargedMicroCredits).toBe(144);
	});
});

describe("standing", () => {
	const shortSince = new Date("2026-11-11T06:41:00Z");
	const short = {
		createdAt: shortSince,
		owedMicroCredits: 144,
		shortSince,
	};
	const at = (iso: string) => new Date(iso);

	it("is active with no storage charge or a fully paid one", () => {
		expect(
			resolveStanding({
				balanceMicroCredits: 0,
				lastCharge: null,
				restored: false,
				now: shortSince,
			}),
		).toEqual({ state: "active", pausesAt: null });
		expect(
			resolveStanding({
				balanceMicroCredits: 0,
				lastCharge: { ...short, shortSince: null },
				restored: false,
				now: shortSince,
			}).state,
		).toBe("active");
	});

	it("is grace for seven days after first falling short", () => {
		expect(INFRA_GRACE_DAYS).toBe(7);
		const standing = resolveStanding({
			balanceMicroCredits: 0,
			lastCharge: short,
			restored: false,
			now: at("2026-11-18T06:40:59Z"),
		});
		expect(standing).toEqual({
			state: "grace",
			pausesAt: at("2026-11-18T06:41:00Z"),
		});
	});

	it("is paused from the seventh day on", () => {
		for (const now of ["2026-11-18T06:41:00Z", "2026-12-25T00:00:00Z"]) {
			expect(
				resolveStanding({
					balanceMicroCredits: 0,
					lastCharge: short,
					restored: false,
					now: at(now),
				}),
			).toEqual({ state: "paused", pausesAt: at("2026-11-18T06:41:00Z") });
		}
	});

	it("returns to active as soon as the balance covers what was owed", () => {
		expect(
			resolveStanding({
				balanceMicroCredits: 144,
				lastCharge: short,
				restored: false,
				now: at("2026-12-25T00:00:00Z"),
			}).state,
		).toBe("active");
		expect(
			resolveStanding({
				balanceMicroCredits: 143,
				lastCharge: short,
				restored: false,
				now: at("2026-11-12T00:00:00Z"),
			}).state,
		).toBe("grace");
	});

	it("stays active after a top-up restored it, even if the balance is spent again before the next charge", () => {
		expect(
			resolveStanding({
				balanceMicroCredits: 0,
				lastCharge: short,
				restored: true,
				now: at("2026-12-25T00:00:00Z"),
			}).state,
		).toBe("active");
	});

	it("reads a storage charge from its ledger row, as an object or as text", () => {
		const metadata = {
			owedMicroCredits: 144,
			chargedMicroCredits: 50,
			shortSince: shortSince.toISOString(),
		};
		for (const value of [metadata, JSON.stringify(metadata)]) {
			expect(
				parseStorageCharge({ createdAt: shortSince, metadata: value }),
			).toEqual(short);
		}
		expect(
			parseStorageCharge({
				createdAt: shortSince,
				metadata: { totalDurationMinutes: 10, videoCount: 5 },
			}),
		).toEqual({ createdAt: shortSince, owedMicroCredits: 0, shortSince: null });
		expect(
			parseStorageCharge({ createdAt: shortSince, metadata: "not json" })
				.shortSince,
		).toBe(null);
	});
});
