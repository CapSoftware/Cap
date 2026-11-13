import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));

import {
	clearFirstMonthChargesBeganCache,
	firstMonthChargesBegan,
} from "@/lib/infra-first-month-start";

const FIRST_CHARGE = new Date("2026-11-13T10:39:54.000Z");

const reader = (results: (Date | null)[]) => {
	const reads = { count: 0 };
	const chain = (outer: boolean) => {
		const query = {
			from: () => query,
			where: () => query,
			orderBy: () => query,
			limit: () => query,
			then: outer
				? (resolve: (rows: { createdAt: Date | null }[]) => unknown) => {
						reads.count += 1;
						const next = results.shift() ?? null;
						return Promise.resolve([
							{ createdAt: next ? new Date(next.getTime()) : null },
						]).then(resolve);
					}
				: undefined,
		};
		return query;
	};
	let selects = 0;
	const database = {
		select: (fields: Record<string, unknown>) => {
			selects += 1;
			return chain("createdAt" in fields && !("storagePaidUntil" in fields));
		},
	} as unknown as Parameters<typeof firstMonthChargesBegan>[0];
	return { database, reads, selects: () => selects };
};

describe("when first month charging began", () => {
	beforeEach(() => {
		clearFirstMonthChargesBeganCache();
	});

	it("reads the start once it is known, and never queries for it again", async () => {
		const first = reader([FIRST_CHARGE]);
		expect(await firstMonthChargesBegan(first.database)).toEqual(FIRST_CHARGE);
		expect(first.reads.count).toBe(1);

		const second = reader([new Date("2027-01-01T00:00:00.000Z")]);
		expect(await firstMonthChargesBegan(second.database)).toEqual(FIRST_CHARGE);
		expect(second.selects()).toBe(0);
		expect(second.reads.count).toBe(0);
	});

	it("reads again every time while no first month charge exists, then keeps the first one found", async () => {
		const database = reader([null, null, FIRST_CHARGE]);

		expect(await firstMonthChargesBegan(database.database)).toBeNull();
		expect(await firstMonthChargesBegan(database.database)).toBeNull();
		expect(await firstMonthChargesBegan(database.database)).toEqual(
			FIRST_CHARGE,
		);
		expect(await firstMonthChargesBegan(database.database)).toEqual(
			FIRST_CHARGE,
		);
		expect(database.reads.count).toBe(3);
	});

	it("hands out a copy, so a caller cannot move the start", async () => {
		const database = reader([FIRST_CHARGE]);
		const began = await firstMonthChargesBegan(database.database);
		began?.setTime(0);

		expect(await firstMonthChargesBegan(database.database)).toEqual(
			FIRST_CHARGE,
		);
	});
});
