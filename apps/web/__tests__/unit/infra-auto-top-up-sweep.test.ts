import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Account = { id: string; lastAttemptAt: Date | null; waiting?: boolean };

const state = vi.hoisted(() => ({
	accounts: [] as {
		id: string;
		lastAttemptAt: Date | null;
		waiting?: boolean;
	}[],
	pages: [] as {
		sql: string;
		params: unknown[];
		after: { key: string; id: string } | null;
		limit: number;
	}[],
	reads: [] as string[],
	msPerAccount: 0,
	other: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const NEVER = "1970-01-01 00:00:00";
	const keyOf = (account: { lastAttemptAt: Date | null }) =>
		account.lastAttemptAt
			? account.lastAttemptAt.toISOString().slice(0, 19).replace("T", " ")
			: NEVER;
	const client = drizzle(async (sql, params) => {
		if (sql.startsWith("select `developer_credit_accounts`.`id`, cast(")) {
			const limit = Number(params.at(-1));
			const keyset = sql.includes("and `developer_credit_accounts`.`id` > ?))");
			const after = keyset
				? { key: String(params.at(-4)), id: String(params.at(-2)) }
				: null;
			state.pages.push({ sql, params, after, limit });
			const rows = state.accounts
				.filter((account) => !account.waiting)
				.map((account) => ({ id: account.id, key: keyOf(account) }))
				.filter(
					(row) =>
						!after ||
						row.key > after.key ||
						(row.key === after.key && row.id > after.id),
				)
				.sort((a, b) =>
					a.key === b.key ? a.id.localeCompare(b.id) : a.key < b.key ? -1 : 1,
				)
				.slice(0, limit);
			return { rows: rows.map((row) => [row.id, row.key]) };
		}
		if (sql.startsWith("select `developer_credit_accounts`.`id` from")) {
			const limit = Number(params.at(-1));
			const cursor = sql.includes("`id` > ?") ? String(params.at(-2)) : null;
			state.pages.push({
				sql,
				params,
				after: cursor ? { key: "", id: cursor } : null,
				limit,
			});
			return {
				rows: state.accounts
					.filter((account) => cursor === null || account.id > cursor)
					.slice(0, limit)
					.map((account) => [account.id]),
			};
		}
		if (sql.includes("`developer_apps`.`name`")) {
			state.reads.push(String(params[0]));
			vi.setSystemTime(Date.now() + state.msPerAccount);
			return { rows: [] };
		}
		state.other.push({ sql, params });
		return { rows: [] };
	});
	return { db: () => client };
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "row",
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/utils", () => ({ stripe: () => ({}) }));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraTopUpFailedEmail: vi.fn(),
}));

import {
	AUTO_TOP_UP_DAILY_LIMIT,
	getAutoTopUpFailure,
	runDueAutoTopUps,
} from "@/lib/infra-auto-top-up";

const NOW = new Date("2026-11-13T06:41:00Z");
const HOUR_MS = 60 * 60 * 1000;

const accounts = (
	count: number,
	from = 0,
	lastAttemptAt: Date | null = null,
	waiting = false,
): Account[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `account-${String(from + index).padStart(4, "0")}`,
		lastAttemptAt,
		waiting,
	}));

const sqlTime = (date: Date) =>
	date.toISOString().slice(0, 23).replace("T", " ");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	state.accounts = accounts(450);
	state.pages = [];
	state.reads = [];
	state.msPerAccount = 0;
	state.other = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("auto top-up sweep selection", () => {
	it("pages through due accounts by last attempt, then id", async () => {
		await runDueAutoTopUps(NOW);

		expect(state.pages.map(({ after, limit }) => ({ after, limit }))).toEqual([
			{ after: null, limit: 200 },
			{ after: { key: "1970-01-01 00:00:00", id: "account-0199" }, limit: 200 },
			{ after: { key: "1970-01-01 00:00:00", id: "account-0399" }, limit: 200 },
		]);
		expect(state.reads).toHaveLength(450);
	});

	it("asks the database for enabled accounts under their threshold after held credit that nothing makes wait", async () => {
		state.accounts = [];

		await runDueAutoTopUps(NOW);

		expect(state.pages).toHaveLength(1);
		const { sql, params } = state.pages[0] ?? { sql: "", params: [] };
		expect(sql).toContain("`autoTopUpEnabled` = ?");
		expect(sql).toContain("`stripePaymentMethodId` is not null");
		expect(sql).toContain(
			"left join (select `appId`, COALESCE(SUM(`reservedMicroCredits`), 0) as `heldMicroCredits` from `developer_transcripts` where `developer_transcripts`.`status` = ? group by `developer_transcripts`.`appId`) `held` on `held`.`appId` = `developer_credit_accounts`.`appId`",
		);
		expect(sql).toContain(
			"`balanceMicroCredits` < `developer_credit_accounts`.`autoTopUpThresholdMicroCredits` + coalesce(`heldMicroCredits`, 0)",
		);
		expect(sql).toContain(
			"(select max(`developer_credit_transactions`.`createdAt`) from `developer_credit_transactions` where `developer_credit_transactions`.`accountId` = `developer_credit_accounts`.`id` and `developer_credit_transactions`.`type` in (?, ?, ?) and `developer_credit_transactions`.`referenceType` in (?, ?, ?))",
		);
		expect(sql).toContain(
			"not (exists (select 1 from `developer_credit_transactions` `pending_attempt` where `pending_attempt`.`accountId` = `developer_credit_accounts`.`id` and `pending_attempt`.`type` = ? and `pending_attempt`.`referenceType` = ? and `pending_attempt`.`createdAt` > ? and `pending_attempt`.`referenceId` not like ? and not exists (select 1 from `developer_credit_transactions` `settled_attempt` where `settled_attempt`.`accountId` = `pending_attempt`.`accountId` and `settled_attempt`.`referenceId` = `pending_attempt`.`referenceId`",
		);
		expect(sql).toContain(
			"exists (select 1 from `developer_credit_transactions` `declined_attempt` where `declined_attempt`.`accountId` = `developer_credit_accounts`.`id` and `declined_attempt`.`type` = ? and `declined_attempt`.`referenceType` = ? and `declined_attempt`.`createdAt` > ? and not exists (select 1 from `developer_credit_transactions` `later_top_up` where `later_top_up`.`accountId` = `declined_attempt`.`accountId` and `later_top_up`.`type` = ?",
		);
		expect(sql).toContain(
			"(select count(*) from `developer_credit_transactions` `recent_top_up` where `recent_top_up`.`accountId` = `developer_credit_accounts`.`id` and `recent_top_up`.`type` = ? and `recent_top_up`.`referenceType` = ? and `recent_top_up`.`createdAt` > ?) >= ?",
		);
		expect(sql).toMatch(
			/order by attemptKey, `developer_credit_accounts`\.`id` asc limit \?$/,
		);
		expect(params).toContain(sqlTime(new Date(NOW.getTime() - 72 * HOUR_MS)));
		expect(params).toContain(sqlTime(new Date(NOW.getTime() - 24 * HOUR_MS)));
		expect(params).toContain(AUTO_TOP_UP_DAILY_LIMIT);
		expect(params).toContain("infra-auto-top-up:%");
		expect(sql).toContain(
			"or exists (select 1 from `developer_credit_transactions` `stale_payment` where `stale_payment`.`accountId` = `developer_credit_accounts`.`id` and `stale_payment`.`type` = ? and `stale_payment`.`referenceType` = ? and `stale_payment`.`createdAt` <= ?",
		);
		expect(sql).toContain(
			"from `developer_credit_accounts` `owner_account` join `developer_credit_transactions` `owner_entry` on `owner_entry`.`accountId` = `owner_account`.`id` where `owner_account`.`ownerId` = `developer_credit_accounts`.`ownerId`",
		);
	});

	it("tries the least recently tried account first", async () => {
		state.accounts = [
			{
				id: "account-0001",
				lastAttemptAt: new Date(NOW.getTime() - 26 * HOUR_MS),
			},
			{ id: "account-0002", lastAttemptAt: null },
			{
				id: "account-0003",
				lastAttemptAt: new Date(NOW.getTime() - 30 * HOUR_MS),
			},
			{
				id: "account-0004",
				lastAttemptAt: new Date(NOW.getTime() - 2 * HOUR_MS),
			},
			{ id: "account-0005", lastAttemptAt: null },
		];

		await runDueAutoTopUps(NOW);

		expect(state.reads).toEqual([
			"account-0002",
			"account-0005",
			"account-0003",
			"account-0001",
			"account-0004",
		]);
	});

	it("reaches 50 due accounts in one run behind 300 accounts that must wait", async () => {
		const tried = accounts(300, 0, new Date(NOW.getTime() - HOUR_MS), true);
		const due = accounts(50, 300);
		state.accounts = [...tried, ...due];
		state.msPerAccount = 250;

		await runDueAutoTopUps(NOW, { until: NOW.getTime() + 60_000 });

		expect(state.reads).toEqual(due.map((account) => account.id));
	});

	it("stops between accounts when its time is up", async () => {
		state.msPerAccount = 1000;

		await runDueAutoTopUps(NOW, { until: NOW.getTime() + 10_500 });

		expect(state.reads).toHaveLength(11);
		expect(state.pages).toHaveLength(1);
	});
});

describe("last auto top-up lookup", () => {
	it("reads the account's top-up rows by type, so the account and type index serves it", async () => {
		expect(await getAutoTopUpFailure("account-0001")).toBeNull();

		expect(state.other).toHaveLength(1);
		const [{ sql, params }] = state.other as [
			{ sql: string; params: unknown[] },
		];
		expect(sql).toContain(
			"where (`developer_credit_transactions`.`accountId` = ? and `developer_credit_transactions`.`type` in (?, ?) and `developer_credit_transactions`.`referenceType` in (?, ?))",
		);
		expect(sql).toContain(
			"order by `developer_credit_transactions`.`createdAt` desc limit ?",
		);
		expect(params).toEqual([
			"account-0001",
			"topup",
			"topup_failed",
			"auto_top_up",
			"auto_top_up_failed",
			1,
		]);
	});
});
