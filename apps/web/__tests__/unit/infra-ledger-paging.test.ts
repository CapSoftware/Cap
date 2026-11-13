import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; createdAt: Date; amountMicroCredits: number };

const state = vi.hoisted(() => ({
	rows: [] as Row[],
	queries: [] as string[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const toDate = (value: unknown) =>
		new Date(`${String(value).replace(" ", "T")}Z`);
	const stamp = (date: Date) =>
		date.toISOString().slice(0, 19).replace("T", " ");
	const client = drizzle(async (sql, params) => {
		state.queries.push(sql);
		const ascending = sql.includes(
			"order by `developer_credit_transactions`.`createdAt` asc",
		);
		const sorted = [...state.rows].sort(
			(a, b) =>
				a.createdAt.getTime() - b.createdAt.getTime() ||
				a.id.localeCompare(b.id),
		);
		if (!ascending) sorted.reverse();
		let rest = params.slice(1);
		let matching = sorted;
		if (sql.includes("`createdAt` < ?") || sql.includes("`createdAt` > ?")) {
			const at = toDate(rest[0]).getTime();
			const id = String(rest[2]);
			rest = rest.slice(3);
			matching = sorted.filter((row) => {
				const time = row.createdAt.getTime();
				return ascending
					? time > at || (time === at && row.id > id)
					: time < at || (time === at && row.id < id);
			});
		}
		const limit = Number(rest[0]);
		const offset = sql.includes("offset ?") ? Number(rest[1]) : 0;
		return {
			rows: matching
				.slice(offset, offset + limit)
				.map((row) => [
					row.id,
					"transcription",
					row.amountMicroCredits,
					0,
					null,
					null,
					null,
					stamp(row.createdAt),
				]),
		};
	});
	return { db: () => client };
});

import { LEDGER_PAGE_SIZE } from "@/lib/infra-ledger";
import {
	formatLedgerCursor,
	listAppLedger,
	listAppLedgerPage,
	parseLedgerCursor,
} from "@/lib/infra-ledger-store";

const START = Date.parse("2026-11-01T00:00:00Z");

const seed = (count: number) => {
	state.rows = Array.from({ length: count }, (_, index) => ({
		id: `txn${String(index).padStart(5, "0")}`,
		createdAt: new Date(START + Math.floor(index / 3) * 1000),
		amountMicroCredits: -(index + 1),
	}));
};

const newestFirst = () =>
	[...state.rows]
		.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() ||
				b.id.localeCompare(a.id),
		)
		.map((row) => row.id);

const ids = (page: { rows: { id: string }[] }) =>
	page.rows.map((row) => row.id).sort();

const page = (cursor: { before?: string | null; after?: string | null } = {}) =>
	listAppLedgerPage("app-1", {
		limit: LEDGER_PAGE_SIZE,
		before: parseLedgerCursor(cursor.before),
		after: parseLedgerCursor(cursor.after),
	});

beforeEach(() => {
	state.queries = [];
	seed(120);
});

describe("ledger pages by cursor", () => {
	it("lists the newest page in one query, with no count", async () => {
		const first = await page();

		expect(first.rows).toHaveLength(LEDGER_PAGE_SIZE);
		expect(ids(first)).toEqual(newestFirst().slice(0, 50).sort());
		expect(first.newer).toBeNull();
		expect(first.older).not.toBeNull();
		expect(state.queries).toHaveLength(1);
		expect(state.queries.join("\n")).not.toMatch(/count\(/i);
		expect(state.queries.join("\n")).not.toContain("offset");
	});

	it("walks every row once going Older, across rows written in the same second", async () => {
		const seen: string[] = [];
		let current = await page();
		seen.push(...ids(current));
		while (current.older) {
			current = await page({ before: current.older });
			seen.push(...ids(current));
		}

		expect(seen).toHaveLength(120);
		expect(new Set(seen).size).toBe(120);
		expect(current.rows).toHaveLength(20);
		expect(current.older).toBeNull();
		expect(state.queries).toHaveLength(3);
	});

	it("returns to the same page going Newer", async () => {
		const first = await page();
		const second = await page({ before: first.older });
		const third = await page({ before: second.older });

		const backToSecond = await page({ after: third.newer });
		const backToFirst = await page({ after: backToSecond.newer });

		expect(ids(backToSecond)).toEqual(ids(second));
		expect(backToSecond.older).toBe(second.older);
		expect(ids(backToFirst)).toEqual(ids(first));
		expect(backToFirst.newer).toBeNull();
	});

	it("shows a full newest page when fewer than a page of rows is newer", async () => {
		const first = await page();
		const second = await page({ before: first.older });
		state.rows.push({
			id: "txn99999",
			createdAt: new Date(START + 3_600_000),
			amountMicroCredits: -1,
		});

		const anchor = state.rows.find((row) => row.id === "txn00100");
		if (!anchor) throw new Error("seed row missing");
		const afterOne = await page({ after: formatLedgerCursor(anchor) });
		const backToFirst = await page({ after: second.newer });
		const top = await page({ after: backToFirst.newer });

		expect(afterOne.rows).toHaveLength(LEDGER_PAGE_SIZE);
		expect(afterOne.newer).toBeNull();
		expect(backToFirst.rows).toHaveLength(LEDGER_PAGE_SIZE);
		expect(backToFirst.newer).not.toBeNull();
		expect(top.rows).toHaveLength(LEDGER_PAGE_SIZE);
		expect(top.newer).toBeNull();
		expect(top.rows.some((row) => row.id === "txn99999")).toBe(true);
	});

	it("keeps a cursor that survives a URL and ignores one that is not a cursor", async () => {
		const row = { id: "0abc9xyz", createdAt: new Date(START) };
		const cursor = formatLedgerCursor(row);

		expect(cursor).toBe(`${START}.0abc9xyz`);
		expect(encodeURIComponent(cursor)).toBe(cursor);
		expect(parseLedgerCursor(cursor)).toEqual(row);
		for (const bad of [undefined, null, "", "3", "abc.def", `${START}.ABC`]) {
			expect(parseLedgerCursor(bad)).toBeNull();
		}
		expect(ids(await page({ before: "not-a-cursor" }))).toEqual(
			ids(await page()),
		);
	});

	it("shows no page links for a ledger that fits one page", async () => {
		seed(7);

		expect(await page()).toMatchObject({ newer: null, older: null });
		expect((await page()).rows).toHaveLength(7);
	});
});

describe("the transactions API keeps limit and offset", () => {
	it("lists with limit and offset in one query and never counts", async () => {
		const result = await listAppLedger("app-1", { limit: 50, offset: 100 });

		expect(result.rows).toHaveLength(20);
		expect(result.hasMore).toBe(false);
		expect(
			(await listAppLedger("app-1", { limit: 50, offset: 0 })).hasMore,
		).toBe(true);
		expect(state.queries).toHaveLength(2);
		expect(state.queries[0]).toContain("limit ? offset ?");
		expect(state.queries.join("\n")).not.toMatch(/count\(/i);
	});
});
