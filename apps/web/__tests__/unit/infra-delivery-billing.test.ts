import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => null }));
process.env.CAP_INFRA_DELIVERY_BILLING_FROM = "2026-11-20";

const { deliveryBillingStart, deliveryDayIsFinal, deliverySettleDays } =
	await import("@/lib/infra-delivery-billing");
const {
	DELIVERY_MICRO_CREDITS_PER_1000_MINUTES,
	deliveryMicroCredits,
	groupDeliveredDays,
	isRollupNotReadyError,
} = await import("@/lib/infra-delivery-rollup");
const { INFRA_DELIVERY_BILLED_FROM, INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES } =
	await import("@/lib/infra-pricing");
const { MICRO_CREDITS_PER_DOLLAR } = await import("@/lib/developer-pricing");
const { describeLedgerRow, ledgerCsvLine } = await import("@/lib/infra-ledger");

describe("delivery price", () => {
	it("is one flat rate for every resolution", () => {
		expect(INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES).toBe(0.95);
		expect(DELIVERY_MICRO_CREDITS_PER_1000_MINUTES).toBe(95_000);
	});

	it("charges N/1000 of the price for N minutes, in micro-credits", () => {
		for (const minutes of [1, 7, 60, 1000, 12_345, 1_000_000]) {
			expect(deliveryMicroCredits(minutes * 60)).toBe(
				Math.floor(
					(minutes *
						Math.round(
							INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES *
								MICRO_CREDITS_PER_DOLLAR,
						)) /
						1000,
				),
			);
		}
	});

	it("charges whole micro-credits, floored once over the day's delivered seconds", () => {
		expect(deliveryMicroCredits(0)).toBe(0);
		expect(deliveryMicroCredits(-60)).toBe(0);
		expect(deliveryMicroCredits(Number.NaN)).toBe(0);
		expect(deliveryMicroCredits(60)).toBe(95);
		expect(deliveryMicroCredits(1)).toBe(1);
		expect(deliveryMicroCredits(4234)).toBe(6703);
		expect(deliveryMicroCredits(60_000_000)).toBe(95_000_000);
	});
});

describe("delivery rollup rows", () => {
	it("adds final video tiers per app and day, leaves audio out of the minutes, and holds a day with any row not final", () => {
		const days = groupDeliveredDays([
			{
				appId: "a",
				day: "2026-11-20",
				tier: "1080p",
				seconds: "3000",
				final: 1,
			},
			{
				appId: "a",
				day: "2026-11-20",
				tier: "720p",
				seconds: 1234,
				final: true,
			},
			{ appId: "a", day: "2026-11-20", tier: "audio", seconds: 99, final: "1" },
			{ appId: "a", day: "2026-11-21", tier: "360p", seconds: 60, final: 1 },
			{ appId: "a", day: "2026-11-21", tier: "720p", seconds: 60, final: 0 },
			{ appId: "b", day: "2026-11-20", tier: "2160p", seconds: 0, final: 1 },
			{
				appId: "b",
				day: "2026-11-21",
				tier: "2160p",
				seconds: 10,
				final: null,
			},
			{ appId: null, day: "2026-11-20", tier: "1080p", seconds: 10, final: 1 },
			{ appId: "c", day: "20-11-2026", tier: "1080p", seconds: 10, final: 1 },
		]);
		expect(days).toEqual([
			{
				appId: "a",
				day: "2026-11-20",
				seconds: 4234,
				secondsByTier: { "1080p": 3000, "720p": 1234 },
				final: true,
			},
			{
				appId: "a",
				day: "2026-11-21",
				seconds: 0,
				secondsByTier: {},
				final: false,
			},
			{
				appId: "b",
				day: "2026-11-20",
				seconds: 0,
				secondsByTier: {},
				final: true,
			},
			{
				appId: "b",
				day: "2026-11-21",
				seconds: 0,
				secondsByTier: {},
				final: false,
			},
		]);
	});

	it("knows a missing table or column however the driver wraps it, and nothing else", () => {
		expect(isRollupNotReadyError({ errno: 1146 })).toBe(true);
		expect(isRollupNotReadyError({ errno: 1054 })).toBe(true);
		expect(isRollupNotReadyError({ code: "ER_BAD_FIELD_ERROR" })).toBe(true);
		expect(
			isRollupNotReadyError(
				new Error("Failed query", {
					cause: Object.assign(new Error("no table"), {
						code: "ER_NO_SUCH_TABLE",
					}),
				}),
			),
		).toBe(true);
		expect(isRollupNotReadyError({ errno: 1062 })).toBe(false);
		expect(isRollupNotReadyError(new Error("Connection lost"))).toBe(false);
		expect(isRollupNotReadyError(null)).toBe(false);
	});
});

describe("delivery billing flag", () => {
	it("never starts before the day the pricing copy says delivery is billed from", () => {
		expect(INFRA_DELIVERY_BILLED_FROM).toBe("2026-11-14");
		expect(deliveryBillingStart("2026-11-01")).toBe("2026-11-14");
		expect(deliveryBillingStart("2026-11-13")).toBe("2026-11-14");
		expect(deliveryBillingStart("2026-11-14")).toBe("2026-11-14");
		expect(deliveryBillingStart("2026-11-15")).toBe("2026-11-15");
	});

	it("reads the first billable day, and is off for anything that is not a real day", () => {
		expect(deliveryBillingStart()).toBe("2026-11-20");
		expect(deliveryBillingStart(" 2026-11-20 ")).toBe("2026-11-20");
		for (const value of [
			"",
			" ",
			"true",
			"1",
			"2026-11-31",
			"2026-13-01",
			"2026-1-1",
			"2026-11-20T00:00:00Z",
		]) {
			expect(deliveryBillingStart(value)).toBeNull();
		}
	});

	it("settles the days that ended two to seven days ago, from the start day on", () => {
		const now = new Date("2026-11-25T06:41:00Z");
		expect(deliverySettleDays(now, "2026-01-01")).toEqual([
			"2026-11-18",
			"2026-11-19",
			"2026-11-20",
			"2026-11-21",
			"2026-11-22",
			"2026-11-23",
		]);
		expect(deliverySettleDays(now, "2026-11-22")).toEqual([
			"2026-11-22",
			"2026-11-23",
		]);
		expect(deliverySettleDays(now, "2026-11-24")).toEqual([]);
	});

	it("treats a day as final only when health marked it final and D+2 has begun", () => {
		const settleTime = new Date("2026-11-24T00:00:00Z");
		expect(
			deliveryDayIsFinal({ day: "2026-11-22", final: true }, settleTime),
		).toBe(true);
		expect(
			deliveryDayIsFinal(
				{ day: "2026-11-22", final: true },
				new Date(settleTime.getTime() - 1),
			),
		).toBe(false);
		expect(
			deliveryDayIsFinal({ day: "2026-11-22", final: false }, settleTime),
		).toBe(false);
	});
});

describe("delivery ledger rows", () => {
	const row = (overrides: Record<string, unknown> = {}) => ({
		id: "row-1",
		type: "delivery_daily",
		amountMicroCredits: -6703,
		balanceAfterMicroCredits: 993297,
		referenceId: "2026-11-20",
		referenceType: "delivery_day",
		metadata: {
			deliveryDate: "2026-11-20",
			owedMicroCredits: 6703,
			chargedMicroCredits: 6703,
			shortSince: null,
			minutesByTier: { "720p": 20.57, "1080p": 50, "2160p": 0 },
		},
		createdAt: new Date("2026-11-22T00:41:05Z"),
		...overrides,
	});

	it("names the day and lists the minutes by tier, highest first", () => {
		expect(describeLedgerRow(row())).toEqual({
			label: "Delivery",
			note: "70.57 minutes delivered (1080p 50, 720p 20.57).",
			reference: { kind: "Day", value: "2026-11-20" },
		});
		expect(ledgerCsvLine(row())).toBe(
			'row-1,2026-11-22T00:41:05Z,Delivery,"70.57 minutes delivered (1080p 50, 720p 20.57).",Day,2026-11-20,-0.06703,-6703,9.93297,993297\r\n',
		);
	});

	it("says when the balance paid part or none of the day, like a storage day", () => {
		const short = { shortSince: "2026-11-22T00:41:05.000Z" };
		expect(
			describeLedgerRow(
				row({
					amountMicroCredits: -1000,
					metadata: { ...row().metadata, ...short },
				}),
			).note,
		).toBe(
			"70.57 minutes delivered (1080p 50, 720p 20.57). The balance paid for part of this day. The rest is not charged later.",
		);
		expect(
			describeLedgerRow(
				row({
					amountMicroCredits: 0,
					metadata: { ...row().metadata, ...short },
				}),
			),
		).toMatchObject({
			label: "Delivery, unpaid",
			note: "70.57 minutes delivered (1080p 50, 720p 20.57). The balance could not pay for this day. It is not charged later.",
		});
	});

	it("still describes a row with a bad day or unreadable metadata", () => {
		expect(
			describeLedgerRow(row({ referenceId: "soon", metadata: "{not json" })),
		).toEqual({
			label: "Delivery",
			note: null,
			reference: { kind: "Day", value: "soon" },
		});
	});
});
