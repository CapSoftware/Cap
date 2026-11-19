import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown, ids: 0 }));

vi.mock("@cap/database", () => ({ db: () => holder.db }));
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `row-${++holder.ids}`,
	nanoIdLength: 15,
}));

import { fakeDb, ledger, resetLedger } from "./infra-billing-fake-db";

holder.db = fakeDb;

import {
	disputedSince,
	getInfraAppStanding,
	readStandingAccount,
} from "@/lib/infra-standing";

const adjustment = (id: string, referenceType: string, createdAt: Date) => ({
	id,
	accountId: ledger.account.id,
	type: "adjustment",
	amountMicroCredits: 0,
	balanceAfterMicroCredits: ledger.account.balanceMicroCredits,
	referenceId: id,
	referenceType,
	createdAt,
});

beforeEach(() => {
	resetLedger();
	holder.ids = 0;
});

describe("a dispute and a review written in the same second", () => {
	const second = new Date("2026-11-11T06:00:00.000Z");

	it("is decided by the larger id, not by which was written first", async () => {
		ledger.rows.push(adjustment("z-review", "manual", second));
		ledger.rows.push(adjustment("a-dispute", "stripe_dispute", second));

		expect(await disputedSince(fakeDb as never, ledger.account.id)).toBeNull();
		expect((await readStandingAccount("app-1"))?.disputedAt).toBeNull();
		expect(await getInfraAppStanding("app-1")).toMatchObject({
			state: "active",
		});
	});

	it("is disputed when the dispute has the larger id, whichever was written first", async () => {
		ledger.rows.push(adjustment("z-dispute", "stripe_dispute", second));
		ledger.rows.push(adjustment("a-review", "manual", second));

		expect(await disputedSince(fakeDb as never, ledger.account.id)).toEqual(
			second,
		);
		expect((await readStandingAccount("app-1"))?.disputedAt).toEqual(second);
		expect(await getInfraAppStanding("app-1")).toMatchObject({
			state: "paused",
			disputed: true,
		});
	});
});
