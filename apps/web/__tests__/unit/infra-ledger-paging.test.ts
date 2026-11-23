import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	createdAt: Date;
	amountMicroCredits: number;
	balanceAfterMicroCredits?: number;
};

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
		if (sql.includes("`createdAt` >= ?")) {
			const from = toDate(rest[0]).getTime();
			const to = toDate(rest[1]).getTime();
			matching = sorted.filter(
				(row) =>
					row.createdAt.getTime() >= from && row.createdAt.getTime() <= to,
			);
			rest = [matching.length];
		} else if (
			sql.includes("`createdAt` < ?") ||
			sql.includes("`createdAt` > ?")
		) {
			const at = toDate(rest[0]).getTime();
			const id = String(rest[2]);
			rest = rest.slice(3);
			matching = sorted.filter((row) => {
				const time = row.createdAt.getTime();
				return ascending
					? time > at || (time === at && row.id > id)
					: time < at || (time === at && row.id < id);
			});
		} else if (sql.includes("`createdAt` = ?")) {
			const at = toDate(rest[0]).getTime();
			matching = sorted.filter((row) => row.createdAt.getTime() === at);
			rest = [matching.length];
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
					row.balanceAfterMicroCredits ?? 0,
					null,
					null,
					null,
					stamp(row.createdAt),
				]),
		};
	});
	return { db: () => client };
});

import { LEDGER_PAGE_SIZE, type LedgerRow } from "@/lib/infra-ledger";
import {
	formatLedgerCursor,
	listAppLedger,
	listAppLedgerPage,
	parseLedgerCursor,
	readAppLedger,
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
	it("lists with limit and offset and never counts", async () => {
		const result = await listAppLedger("app-1", { limit: 50, offset: 100 });

		expect(result.rows).toHaveLength(20);
		expect(result.hasMore).toBe(false);
		expect(
			(await listAppLedger("app-1", { limit: 50, offset: 0 })).hasMore,
		).toBe(true);
		expect(state.queries).toHaveLength(4);
		expect(state.queries[0]).toContain("limit ? offset ?");
		expect(state.queries.join("\n")).not.toMatch(/count\(/i);
	});
});

describe("rows written in the same second across a page edge", () => {
	const SECOND = (offset: number) => new Date(START + offset * 1000);
	const seedChain = () => {
		const groups = [
			{ at: SECOND(0), ids: ["q1", "c7"] },
			{ at: SECOND(1), ids: ["m4", "z9", "a2", "t6", "f3"] },
			{ at: SECOND(2), ids: ["k8", "b5"] },
		];
		let balance = 1_000_000;
		let amount = 11;
		state.rows = groups.flatMap(({ at, ids }) =>
			ids.map((id) => {
				amount += 7;
				balance -= amount;
				return {
					id,
					createdAt: at,
					amountMicroCredits: -amount,
					balanceAfterMicroCredits: balance,
				};
			}),
		);
	};
	const chainBreaks = (
		rows: { amountMicroCredits: number; balanceAfterMicroCredits: number }[],
	) =>
		rows.slice(0, -1).filter((row, index) => {
			const older = rows[index + 1];
			return (
				!older ||
				row.balanceAfterMicroCredits - row.amountMicroCredits !==
					older.balanceAfterMicroCredits
			);
		}).length;
	const walk = async (limit: number) => {
		const rows: LedgerRow[] = [];
		for (let offset = 0; ; offset += limit) {
			const page = await listAppLedger("app-1", { limit, offset });
			rows.push(...page.rows);
			if (!page.hasMore) return rows;
		}
	};

	beforeEach(seedChain);

	it("gives the same chain whatever the page size", async () => {
		const whole = (await listAppLedger("app-1", { limit: 100, offset: 0 }))
			.rows;

		expect(whole).toHaveLength(9);
		expect(chainBreaks(whole)).toBe(0);
		for (const limit of [1, 2, 3, 4, 5, 8]) {
			const paged = await walk(limit);
			expect(
				paged.map((row) => row.id),
				`limit ${limit}`,
			).toEqual(whole.map((row) => row.id));
		}
	});

	it("gives the same chain in an export read in small batches", async () => {
		const whole = (await listAppLedger("app-1", { limit: 100, offset: 0 }))
			.rows;
		for (const batchSize of [2, 3, 4]) {
			const exported: LedgerRow[] = [];
			for await (const batch of readAppLedger("app-1", batchSize)) {
				exported.push(...batch);
			}
			expect(
				exported.map((row) => row.id),
				`batch ${batchSize}`,
			).toEqual(whole.map((row) => row.id));
		}
	});
});
