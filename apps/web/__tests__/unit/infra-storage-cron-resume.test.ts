import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChargeCall = {
	accountId: string;
	dateKey: string;
	retryUnpaid: boolean | undefined;
	dailyMicroCredits: number;
};

const state = vi.hoisted(() => ({
	accounts: [] as { id: string; appId: string; createdAt: Date }[],
	appCreatedAt: new Map<string, Date>(),
	videos: new Map<string, (Date | { createdAt: Date; readyAt: Date })[]>(),
	markers: new Map<string, number>(),
	markerInserts: [] as string[],
	usageReads: [] as { appIds: string[]; createdBefore: Date | undefined }[],
	deletedApps: new Set<string>(),
	unpaid: new Set<string>(),
	short: new Set<string>(),
	everShort: new Set<string>(),
	charged: new Map<string, number>(),
	snapshotWrites: new Map<string, number>(),
	chargeCalls: [] as ChargeCall[],
	accountReads: [] as { cursor: string | null; limit: number | null }[],
	accountSql: [] as string[],
	longestIdList: 0,
	secondsPerCharge: 0,
	topUps: vi.fn(),
	emails: vi.fn(),
	afters: [] as Promise<unknown>[],
	continuations: [] as { url: string; authorization: string | null }[],
	continuationStatus: 200 as number | "network",
}));

vi.mock("next/server", async (original) => ({
	...(await original<typeof import("next/server")>()),
	after: (task: Promise<unknown>) => {
		state.afters.push(task);
	},
}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(async (sql, params) => {
		if (sql.includes("from `developer_credit_accounts`")) {
			const limit = /limit \?/.test(sql) ? Number(params.at(-1)) : null;
			const cursor = /`id` > \?/.test(sql) ? String(params[0]) : null;
			state.accountReads.push({ cursor, limit });
			state.accountSql.push(sql);
			const after = state.accounts.filter(
				(account) => cursor === null || account.id > cursor,
			);
			const stamp = (date: Date) =>
				date.toISOString().slice(0, 19).replace("T", " ");
			return {
				rows: (limit === null ? after : after.slice(0, limit)).map(
					(account) => [account.id, account.appId, stamp(account.createdAt)],
				),
			};
		}
		if (sql.includes("from `developer_apps`")) {
			const bounded = sql.includes("`developer_apps`.`createdAt` < ?");
			const bound = bounded
				? new Date(`${String(params.at(-1)).replace(" ", "T")}Z`)
				: null;
			return {
				rows: (bounded ? params.slice(0, -1) : params)
					.map(String)
					.filter((appId) => !state.deletedApps.has(appId))
					.filter(
						(appId) =>
							!bound ||
							(state.appCreatedAt.get(appId) ?? new Date(0)).getTime() <
								bound.getTime(),
					)
					.map((appId) => [appId]),
			};
		}
		if (sql.includes("from `developer_credit_transactions`")) {
			const ids = params.slice(0, -2).map(String);
			const date = String(params.at(-2));
			state.longestIdList = Math.max(state.longestIdList, ids.length);
			return {
				rows: ids
					.filter((id) => state.charged.has(`${id}|${date}`))
					.map((id) => [id]),
			};
		}
		if (sql.includes("from `developer_daily_storage_snapshots`")) {
			const appIds = params.slice(0, -1).map(String);
			const date = String(params.at(-1));
			return {
				rows: appIds
					.filter(
						(appId) =>
							state.snapshotWrites.has(`${appId}|${date}`) ||
							state.markers.has(`${appId}|${date}`),
					)
					.map((appId) => [appId]),
			};
		}
		throw new Error(`Unexpected query: ${sql}`);
	});
	return { db: () => client };
});
vi.mock("@/lib/infra-storage", () => ({
	getStorageUsageByApp: async (
		appIds: string[],
		_extra?: unknown,
		_executor?: unknown,
		options: { createdBefore?: Date } = {},
	) => {
		state.usageReads.push({ appIds, createdBefore: options.createdBefore });
		return new Map(
			appIds.map((appId) => {
				const videos = (
					state.videos.get(appId) ?? [new Date("2026-11-01T00:00:00Z")]
				)
					.map((video) =>
						video instanceof Date
							? { createdAt: video, readyAt: video }
							: video,
					)
					.filter(
						({ createdAt, readyAt }) =>
							readyAt.getTime() <= Date.now() &&
							(!options.createdBefore ||
								createdAt.getTime() < options.createdBefore.getTime()),
					).length;
				return [
					appId,
					{
						videoCount: videos,
						totalMinutes: videos * 10,
						minutesByTier: { "1080p": videos * 10, "1440p": 0, "2160p": 0 },
						monthlyMicroCredits: videos * 840,
						dailyMicroCredits: videos * 28,
					},
				];
			}),
		);
	},
}));
vi.mock("@/lib/infra-storage-billing", () => ({
	recordStorageDayVisits: async ({
		appIds,
		dateKey,
	}: {
		appIds: string[];
		dateKey: string;
	}) => {
		for (const appId of appIds) {
			const key = `${appId}|${dateKey}`;
			state.markerInserts.push(key);
			if (!state.snapshotWrites.has(key) && !state.markers.has(key)) {
				state.markers.set(key, 1);
			}
		}
	},
	chargeStorageDay: async ({
		appId,
		accountId,
		dateKey,
		retryUnpaid,
		usage,
	}: {
		appId: string;
		accountId: string;
		dateKey: string;
		retryUnpaid?: boolean;
		usage: { dailyMicroCredits: number };
	}) => {
		state.chargeCalls.push({
			accountId,
			dateKey,
			retryUnpaid,
			dailyMicroCredits: usage.dailyMicroCredits,
		});
		vi.setSystemTime(Date.now() + state.secondsPerCharge * 1000);
		const key = `${accountId}|${dateKey}`;
		const snapshot = `${appId}|${dateKey}`;
		if (state.charged.has(key)) return { state: "skipped" };
		const writeSnapshot = () => {
			state.markers.delete(snapshot);
			state.snapshotWrites.set(
				snapshot,
				(state.snapshotWrites.get(snapshot) ?? 0) + 1,
			);
		};
		if (
			retryUnpaid === false &&
			(state.markers.has(snapshot) ||
				(state.unpaid.has(accountId) && state.snapshotWrites.has(snapshot)))
		) {
			return { state: "skipped" };
		}
		if (state.unpaid.has(accountId)) {
			writeSnapshot();
			return { state: "unpaid", shortSince: new Date("2026-11-01T00:00:00Z") };
		}
		if (usage.dailyMicroCredits <= 0) return { state: "skipped" };
		state.charged.set(key, 1);
		writeSnapshot();
		const short = state.short.has(accountId);
		const fellShort = short && !state.everShort.has(accountId);
		if (short) state.everShort.add(accountId);
		return {
			state: "billed",
			owedMicroCredits: 28,
			chargedMicroCredits: short ? 0 : 28,
			balanceMicroCredits: short ? 0 : 972,
			shortSince: short ? new Date("2026-11-12T00:00:00Z") : null,
			fellShort,
		};
	},
}));
vi.mock("@/lib/infra-standing", () => ({
	INFRA_GRACE_DAYS: 7,
	STORAGE_DAY_REFERENCE_TYPE: "storage_day",
	latestStorageCharges: async () => new Map(),
}));
vi.mock("@/lib/infra-auto-top-up", () => ({ runDueAutoTopUps: state.topUps }));
vi.mock("@/lib/infra-billing-emails", () => ({
	sendInfraOutOfCreditEmail: state.emails,
}));

import {
	GET,
	MAX_STORAGE_HOPS,
	maxDuration,
} from "@/app/api/cron/developer-storage/route";

const ACCOUNTS = 450;
const ORIGIN = "https://cap.example";
const PATH = "/api/cron/developer-storage";

type Body = {
	success?: boolean;
	error?: string;
	date: string;
	complete: boolean;
	continued: boolean;
	hop: number;
	appsProcessed: number;
	appsShort: number;
};

const call = async (query = "") => {
	const response = await GET(
		new Request(`${ORIGIN}${PATH}${query}`, {
			headers: { authorization: "Bearer cron-secret" },
		}),
	);
	return { status: response.status, body: (await response.json()) as Body };
};

const run = async (query = "") => (await call(query)).body;

const lastContinuation = () => {
	const last = state.continuations.at(-1);
	if (!last) throw new Error("no continuation was started");
	return new URL(last.url);
};

const followChain = async (
	first: Body,
	between: () => void = () => {},
	limit = MAX_STORAGE_HOPS + 2,
) => {
	const bodies = [first];
	let body = first;
	while (body.continued) {
		if (bodies.length > limit) throw new Error("chain did not end");
		between();
		const next = lastContinuation();
		body = await run(next.search);
		bodies.push(body);
	}
	return bodies;
};

const chargedFor = (date: string) =>
	[...state.charged.keys()]
		.filter((key) => key.endsWith(`|${date}`))
		.map((key) => key.split("|")[0])
		.sort();

const callsFor = (date: string) =>
	state.chargeCalls.filter((call) => call.dateKey === date);

const allIds = () => state.accounts.map((account) => account.id);

const settle = (date: string) => {
	for (const id of allIds()) state.charged.set(`${id}|${date}`, 1);
};

beforeEach(() => {
	process.env.CRON_SECRET = "cron-secret";
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-12T06:41:00Z"));
	state.accounts = Array.from({ length: ACCOUNTS }, (_, index) => {
		const serial = String(index).padStart(4, "0");
		return {
			id: `account-${serial}`,
			appId: `app-${serial}`,
			createdAt: new Date("2026-10-01T00:00:00Z"),
		};
	});
	state.appCreatedAt = new Map();
	state.videos = new Map();
	state.markers = new Map();
	state.markerInserts = [];
	state.usageReads = [];
	state.deletedApps = new Set();
	state.unpaid = new Set();
	state.short = new Set();
	state.everShort = new Set();
	state.charged = new Map();
	state.snapshotWrites = new Map();
	settle("2026-11-11");
	state.chargeCalls = [];
	state.accountReads = [];
	state.accountSql = [];
	state.longestIdList = 0;
	state.secondsPerCharge = 0;
	state.afters = [];
	state.continuations = [];
	state.continuationStatus = 200;
	state.emails.mockReset();
	state.topUps.mockReset();
	state.topUps.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: URL | string, init?: RequestInit) => {
			state.continuations.push({
				url: String(url),
				authorization: new Headers(init?.headers).get("authorization"),
			});
			if (state.continuationStatus === "network") {
				throw new TypeError("fetch failed");
			}
			return new Response(null, { status: state.continuationStatus });
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("storage cron paging", () => {
	it("reads accounts a page at a time, by id, for yesterday and then today, and never sends every id at once", async () => {
		const body = await run();

		expect(body).toMatchObject({
			date: "2026-11-12",
			complete: true,
			continued: false,
			appsProcessed: ACCOUNTS,
		});
		const pages = [
			{ cursor: null, limit: 200 },
			{ cursor: "account-0199", limit: 200 },
			{ cursor: "account-0399", limit: 200 },
		];
		expect(state.accountReads).toEqual([...pages, ...pages]);
		expect(state.longestIdList).toBe(200);
		expect(state.continuations).toEqual([]);
		expect(callsFor("2026-11-11")).toEqual([]);
	});

	it("pages on the account id alone and leaves out accounts of deleted apps", async () => {
		state.deletedApps = new Set(["app-0003", "app-0250"]);

		const body = await run();

		expect(body).toMatchObject({ complete: true, appsProcessed: ACCOUNTS - 2 });
		expect(chargedFor("2026-11-12")).not.toContain("account-0003");
		expect(chargedFor("2026-11-12")).not.toContain("account-0250");
		expect(state.accountSql.every((sql) => !sql.includes("join"))).toBe(true);
	});
});

describe("a cut-off sweep continues itself", () => {
	it("hands the date, the last attempted account and the next hop to a request to itself", async () => {
		state.secondsPerCharge = 1.6;
		const startedAt = Date.now();

		const body = await run();

		expect(body).toMatchObject({
			date: "2026-11-12",
			complete: false,
			continued: true,
			hop: 0,
			appsProcessed: 130,
		});
		expect(Date.now() - startedAt).toBeLessThan(maxDuration * 1000);
		expect(state.afters).toHaveLength(1);
		await Promise.all(state.afters);
		expect(state.continuations).toHaveLength(1);
		const next = lastContinuation();
		expect(next.origin).toBe(ORIGIN);
		expect(next.pathname).toBe(PATH);
		expect(Object.fromEntries(next.searchParams)).toEqual({
			date: "2026-11-12",
			after: "account-0129",
			hop: "1",
		});
		expect(state.continuations[0]?.authorization).toBe("Bearer cron-secret");
	});

	it("resumes a page cut off part way at the first account it did not attempt", async () => {
		state.secondsPerCharge = 1.6;
		await run();
		const attempted = state.chargeCalls.map((call) => call.accountId);
		state.chargeCalls = [];
		state.accountReads = [];
		state.secondsPerCharge = 0;

		const body = await run(lastContinuation().search);

		expect(attempted.at(-1)).toBe("account-0129");
		expect(state.chargeCalls[0]?.accountId).toBe("account-0130");
		expect(state.accountReads).toEqual([
			{ cursor: "account-0129", limit: 200 },
			{ cursor: "account-0329", limit: 200 },
		]);
		expect(body).toMatchObject({
			complete: true,
			continued: false,
			hop: 1,
			appsProcessed: ACCOUNTS - 130,
		});
		expect(chargedFor("2026-11-12")).toEqual(allIds());
	});

	it("never charges again an account an earlier hop charged", async () => {
		state.secondsPerCharge = 1.6;
		const bodies = await followChain(await run());

		expect(bodies.length).toBeGreaterThan(2);
		expect(bodies.at(-1)).toMatchObject({ complete: true, continued: false });
		const attempted = callsFor("2026-11-12").map((call) => call.accountId);
		expect(new Set(attempted).size).toBe(attempted.length);
		expect(chargedFor("2026-11-12")).toEqual(allIds());
		expect(bodies.reduce((total, body) => total + body.appsProcessed, 0)).toBe(
			ACCOUNTS,
		);
	});

	it("finishes the day a continuation started even after midnight, then sweeps the new day", async () => {
		vi.setSystemTime(new Date("2026-11-12T23:56:00Z"));
		state.secondsPerCharge = 1.6;

		const first = await run();
		expect(first).toMatchObject({ date: "2026-11-12", continued: true });
		vi.setSystemTime(new Date("2026-11-13T00:02:00Z"));
		state.secondsPerCharge = 0;

		const bodies = await followChain(first);

		expect(bodies.at(-1)).toMatchObject({
			date: "2026-11-13",
			complete: true,
		});
		expect(chargedFor("2026-11-12")).toEqual(allIds());
		expect(chargedFor("2026-11-13")).toEqual(allIds());
		expect(callsFor("2026-11-12")).toHaveLength(ACCOUNTS);
		expect(callsFor("2026-11-13")).toHaveLength(ACCOUNTS);
	});

	it("reaches funded accounts behind a run of unpaid accounts longer than one run's budget", async () => {
		state.unpaid = new Set(allIds().slice(0, 300));
		state.secondsPerCharge = 1.6;

		const bodies = await followChain(await run());

		const funded = allIds().slice(300);
		expect(chargedFor("2026-11-12")).toEqual(funded);
		expect(bodies.at(-1)).toMatchObject({ complete: true });
		const unpaidCalls = callsFor("2026-11-12").filter((call) =>
			state.unpaid.has(call.accountId),
		);
		expect(unpaidCalls).toHaveLength(300);
		expect(new Set(unpaidCalls.map((call) => call.accountId)).size).toBe(300);
	});
});

describe("a broken chain is finished by the next day's first run", () => {
	const breakOnLastTickOfTheDay = async () => {
		vi.setSystemTime(new Date("2026-11-12T18:41:00Z"));
		state.secondsPerCharge = 1.6;
		state.continuationStatus = "network";
		vi.spyOn(console, "error").mockImplementation(() => {});
		const lastTick = await run();
		await Promise.all(state.afters);
		expect(lastTick).toMatchObject({
			date: "2026-11-12",
			complete: false,
			continued: true,
		});
		expect(console.error).toHaveBeenCalledWith(
			"[developer-storage] Continuation not started",
			expect.objectContaining({ date: "2026-11-12", after: "account-0129" }),
		);
		const firstDayCalls = callsFor("2026-11-12").map((call) => call.accountId);
		vi.setSystemTime(new Date("2026-11-13T00:41:00Z"));
		state.secondsPerCharge = 0;
		state.continuationStatus = 200;
		state.chargeCalls = [];
		return firstDayCalls;
	};

	it("charges the accounts after the cursor for that day, each once, then sweeps today", async () => {
		const chargedBeforeTheBreak = await breakOnLastTickOfTheDay();

		const nextDay = await run();

		expect(nextDay).toMatchObject({
			date: "2026-11-13",
			complete: true,
			continued: false,
			hop: 0,
			appsProcessed: ACCOUNTS - 130 + ACCOUNTS,
		});
		expect(chargedFor("2026-11-12")).toEqual(allIds());
		expect(chargedFor("2026-11-13")).toEqual(allIds());
		const finished = callsFor("2026-11-12").map((call) => call.accountId);
		expect(finished).toEqual(allIds().slice(130));
		expect(finished.some((id) => chargedBeforeTheBreak.includes(id))).toBe(
			false,
		);
		expect(
			callsFor("2026-11-12").every((call) => call.retryUnpaid === false),
		).toBe(true);
		expect(
			callsFor("2026-11-13").every((call) => call.retryUnpaid === true),
		).toBe(true);
	});

	it("does not charge or email again an account that fell short before the break", async () => {
		state.short = new Set(["account-0005", "account-0006", "account-0200"]);
		await breakOnLastTickOfTheDay();
		expect(state.emails).toHaveBeenCalledTimes(2);

		await run();

		expect(state.emails).toHaveBeenCalledTimes(3);
		const emailed = state.emails.mock.calls.map(
			([notice]) => (notice as { accountId: string }).accountId,
		);
		expect(emailed.sort()).toEqual([
			"account-0005",
			"account-0006",
			"account-0200",
		]);
		expect(callsFor("2026-11-12").map((call) => call.accountId)).not.toContain(
			"account-0005",
		);
	});

	it("writes no second snapshot for an account that was unpaid before the break", async () => {
		state.unpaid = new Set([
			"account-0010",
			"account-0011",
			"account-0300",
			"account-0301",
		]);
		await breakOnLastTickOfTheDay();
		expect(state.snapshotWrites.get("app-0010|2026-11-12")).toBe(1);
		expect(state.snapshotWrites.has("app-0300|2026-11-12")).toBe(false);

		await run();

		const finished = callsFor("2026-11-12").map((call) => call.accountId);
		expect(finished).not.toContain("account-0010");
		expect(finished).not.toContain("account-0011");
		expect(finished).toContain("account-0300");
		for (const app of ["app-0010", "app-0011", "app-0300", "app-0301"]) {
			expect(state.snapshotWrites.get(`${app}|2026-11-12`)).toBe(1);
		}
		expect(state.snapshotWrites.get("app-0010|2026-11-13")).toBe(1);
	});

	it("costs a settled yesterday one read per table per page and no charge", async () => {
		settle("2026-11-12");
		vi.setSystemTime(new Date("2026-11-13T00:41:00Z"));
		state.unpaid = new Set(allIds().slice(0, 50));
		for (const id of allIds().slice(0, 50)) {
			state.charged.delete(`${id}|2026-11-12`);
			state.snapshotWrites.set(`${id.replace("account", "app")}|2026-11-12`, 1);
		}

		await run();

		expect(callsFor("2026-11-12")).toEqual([]);
		for (const id of allIds().slice(0, 50)) {
			expect(
				state.snapshotWrites.get(`${id.replace("account", "app")}|2026-11-12`),
			).toBe(1);
		}
	});
});

describe("the finishing pass counts only what existed on that day", () => {
	const nextDayTick = () => {
		vi.setSystemTime(new Date("2026-11-13T00:41:00Z"));
		settle("2026-11-12");
		for (const id of [
			"account-0300",
			"account-0301",
			"account-0302",
			"account-0303",
		]) {
			state.charged.delete(`${id}|2026-11-12`);
		}
	};
	const account = (id: string) => {
		const found = state.accounts.find((row) => row.id === id);
		if (!found) throw new Error(`no ${id}`);
		return found;
	};

	it("does not charge yesterday for an account whose first video arrived after midnight", async () => {
		nextDayTick();
		state.videos.set("app-0300", [new Date("2026-11-13T00:30:00Z")]);

		await run();

		expect(chargedFor("2026-11-12")).not.toContain("account-0300");
		expect(callsFor("2026-11-12").map((call) => call.accountId)).not.toContain(
			"account-0300",
		);
		expect(chargedFor("2026-11-13")).toContain("account-0300");
	});

	it("does not charge yesterday for an account or app created after midnight", async () => {
		nextDayTick();
		account("account-0301").createdAt = new Date("2026-11-13T00:10:00Z");
		state.appCreatedAt.set("app-0302", new Date("2026-11-13T00:10:00Z"));

		await run();

		const finished = callsFor("2026-11-12").map((call) => call.accountId);
		expect(finished).not.toContain("account-0301");
		expect(finished).not.toContain("account-0302");
		expect(finished.sort()).toEqual(["account-0300", "account-0303"]);
		expect(chargedFor("2026-11-13")).toEqual(
			expect.arrayContaining(["account-0301", "account-0302"]),
		);
	});

	it("leaves a video created after midnight out of yesterday's charge and keeps the earlier ones", async () => {
		nextDayTick();
		state.videos.set("app-0303", [
			new Date("2026-11-05T00:00:00Z"),
			new Date("2026-11-12T23:59:59Z"),
			new Date("2026-11-13T00:20:00Z"),
		]);

		await run();

		const [yesterday] = callsFor("2026-11-12").filter(
			(call) => call.accountId === "account-0303",
		);
		const [today] = callsFor("2026-11-13").filter(
			(call) => call.accountId === "account-0303",
		);
		expect(yesterday?.dailyMicroCredits).toBe(56);
		expect(today?.dailyMicroCredits).toBe(84);
	});

	it("bounds only the finishing pass, at the midnight after that day", async () => {
		nextDayTick();

		await run();

		const bounds = state.usageReads.map((read) =>
			read.createdBefore?.toISOString(),
		);
		expect(bounds.filter(Boolean)).toEqual(["2026-11-13T00:00:00.000Z"]);
		expect(bounds.filter((bound) => bound === undefined)).toHaveLength(3);
	});
});

describe("a visit on a day leaves a marker when nothing is charged", () => {
	const tick = (at: string) => {
		vi.setSystemTime(new Date(at));
		return run();
	};
	const insertsFor = (app: string, date: string) =>
		state.markerInserts.filter((key) => key === `${app}|${date}`).length;

	it("does not charge a day for an app that was empty at every run of it, when its first video becomes ready after midnight", async () => {
		state.videos.set("app-0300", [
			{
				createdAt: new Date("2026-11-12T23:00:00Z"),
				readyAt: new Date("2026-11-13T00:20:00Z"),
			},
		]);
		for (const at of [
			"2026-11-12T06:41:00Z",
			"2026-11-12T12:41:00Z",
			"2026-11-12T18:41:00Z",
		]) {
			await tick(at);
		}
		expect(state.markers.has("app-0300|2026-11-12")).toBe(true);

		await tick("2026-11-13T00:41:00Z");

		expect(callsFor("2026-11-12").map((call) => call.accountId)).not.toContain(
			"account-0300",
		);
		expect(chargedFor("2026-11-12")).not.toContain("account-0300");
		expect(chargedFor("2026-11-13")).toContain("account-0300");
	});

	it("charges a video that becomes ready after the last run of its day from the next day, as main does", async () => {
		state.videos.set("app-0300", [
			{
				createdAt: new Date("2026-11-12T19:00:00Z"),
				readyAt: new Date("2026-11-12T19:05:00Z"),
			},
		]);
		for (const at of [
			"2026-11-12T06:41:00Z",
			"2026-11-12T12:41:00Z",
			"2026-11-12T18:41:00Z",
		]) {
			await tick(at);
		}
		expect(state.markers.has("app-0300|2026-11-12")).toBe(true);

		await tick("2026-11-13T00:41:00Z");
		await tick("2026-11-13T06:41:00Z");

		expect(callsFor("2026-11-12").map((call) => call.accountId)).not.toContain(
			"account-0300",
		);
		expect(chargedFor("2026-11-12")).not.toContain("account-0300");
		expect(
			callsFor("2026-11-13").filter(
				(call) => call.accountId === "account-0300",
			),
		).toEqual([expect.objectContaining({ dailyMicroCredits: 28 })]);
		expect(chargedFor("2026-11-13")).toContain("account-0300");
	});

	it("charges a day for an app the sweep never reached that day, for videos created before midnight", async () => {
		state.videos.set("app-0300", [
			new Date("2026-11-12T10:00:00Z"),
			{
				createdAt: new Date("2026-11-13T00:05:00Z"),
				readyAt: new Date("2026-11-13T00:06:00Z"),
			},
		]);
		vi.setSystemTime(new Date("2026-11-12T18:41:00Z"));
		state.secondsPerCharge = 1.6;
		state.continuationStatus = "network";
		vi.spyOn(console, "error").mockImplementation(() => {});
		const lastTick = await run();
		await Promise.all(state.afters);
		expect(lastTick.continued).toBe(true);
		expect(state.markers.has("app-0300|2026-11-12")).toBe(false);
		state.secondsPerCharge = 0;

		await tick("2026-11-13T00:41:00Z");

		const [finished] = callsFor("2026-11-12").filter(
			(call) => call.accountId === "account-0300",
		);
		expect(finished?.dailyMicroCredits).toBe(28);
		expect(chargedFor("2026-11-12")).toContain("account-0300");
		const [today] = callsFor("2026-11-13").filter(
			(call) => call.accountId === "account-0300",
		);
		expect(today?.dailyMicroCredits).toBe(56);
	});

	it("writes one marker per idle app and day, however often the app is visited", async () => {
		const idle = ["app-0400", "app-0401", "app-0402", "app-0403", "app-0404"];
		for (const app of idle) state.videos.set(app, []);

		for (const at of [
			"2026-11-12T06:41:00Z",
			"2026-11-12T12:41:00Z",
			"2026-11-12T18:41:00Z",
			"2026-11-13T00:41:00Z",
			"2026-11-13T06:41:00Z",
		]) {
			await tick(at);
		}

		for (const app of idle) {
			expect(insertsFor(app, "2026-11-12")).toBe(1);
			expect(insertsFor(app, "2026-11-13")).toBe(1);
			expect(state.markers.get(`${app}|2026-11-12`)).toBe(1);
		}
		expect(state.markerInserts).toHaveLength(idle.length * 2);
		expect(
			state.chargeCalls.filter((call) =>
				idle.includes(call.accountId.replace("account", "app")),
			),
		).toEqual([]);
	});

	it("still charges the same day when storage arrives after an idle marker", async () => {
		state.videos.set("app-0410", [
			{
				createdAt: new Date("2026-11-12T09:00:00Z"),
				readyAt: new Date("2026-11-12T10:00:00Z"),
			},
		]);
		await tick("2026-11-12T06:41:00Z");
		expect(state.markers.has("app-0410|2026-11-12")).toBe(true);
		expect(chargedFor("2026-11-12")).not.toContain("account-0410");

		await tick("2026-11-12T12:41:00Z");

		const charged = callsFor("2026-11-12").filter(
			(call) => call.accountId === "account-0410",
		);
		expect(charged).toEqual([
			expect.objectContaining({ dailyMicroCredits: 28, retryUnpaid: true }),
		]);
		expect(chargedFor("2026-11-12")).toContain("account-0410");
		expect(state.snapshotWrites.get("app-0410|2026-11-12")).toBe(1);
		expect(state.markers.has("app-0410|2026-11-12")).toBe(false);
	});
});

describe("the chain is bounded", () => {
	it("stops at the hop limit and logs it", async () => {
		state.secondsPerCharge = 1.6;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const body = await run(
			`?date=2026-11-12&after=account-0099&hop=${MAX_STORAGE_HOPS}`,
		);

		expect(body).toMatchObject({
			complete: false,
			continued: false,
			hop: MAX_STORAGE_HOPS,
		});
		expect(state.afters).toEqual([]);
		expect(state.continuations).toEqual([]);
		expect(errors).toHaveBeenCalledWith(
			"[developer-storage] Sweep stopped at the hop limit",
			expect.objectContaining({ date: "2026-11-12", hop: MAX_STORAGE_HOPS }),
		);
	});

	it("logs a continuation the route refused", async () => {
		state.secondsPerCharge = 1.6;
		state.continuationStatus = 500;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		await run();
		await Promise.all(state.afters);

		expect(errors).toHaveBeenCalledWith(
			"[developer-storage] Continuation refused",
			expect.objectContaining({ status: 500, hop: 1 }),
		);
	});

	it("logs a handoff that is still running, with the next cursor, as information", async () => {
		state.secondsPerCharge = 1.6;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			}),
		);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		await run();
		await Promise.all(state.afters);

		expect(info).toHaveBeenCalledWith(
			"[developer-storage] Continuation still running at handoff",
			{ date: "2026-11-12", after: "account-0129", hop: 1 },
		);
		expect(errors).not.toHaveBeenCalled();
	});

	it("refuses a date other than today or yesterday and any malformed continuation", async () => {
		for (const query of [
			"?date=2026-11-10&hop=1",
			"?date=2026-11-13&hop=1",
			"?date=2026-1-12&hop=1",
			"?date=yesterday&hop=1",
			"?date=2026-11-12",
			"?hop=1",
			"?after=account-0001",
			"?date=2026-11-12&hop=0",
			`?date=2026-11-12&hop=${MAX_STORAGE_HOPS + 1}`,
			"?date=2026-11-12&hop=1&after=a%20b",
			"?date=2026-11-12&hop=1x",
		]) {
			const { status, body } = await call(query);
			expect({ query, status, error: body.error }).toEqual({
				query,
				status: 400,
				error: "Invalid continuation",
			});
		}
		expect(state.chargeCalls).toEqual([]);
		expect(state.topUps).not.toHaveBeenCalled();
		expect((await call("?date=2026-11-11&hop=1")).status).toBe(200);
	});
});

describe("auto top-ups run once per sweep", () => {
	it("runs before charging on the scheduled run and after charging on the last hop only", async () => {
		state.secondsPerCharge = 1.6;
		const startedAt = Date.now();

		const first = await run();
		expect(state.topUps).toHaveBeenCalledTimes(1);
		const [[, before]] = state.topUps.mock.calls as [[Date, { until: number }]];
		expect(before.until - startedAt).toBeGreaterThan(0);
		expect(before.until - startedAt).toBeLessThan(maxDuration * 1000);

		state.topUps.mockClear();
		const second = await run(lastContinuation().search);
		expect(second.continued).toBe(true);
		expect(state.topUps).not.toHaveBeenCalled();

		state.secondsPerCharge = 0;
		const bodies = await followChain(second);
		expect(bodies.at(-1)).toMatchObject({ complete: true });
		expect(state.topUps).toHaveBeenCalledTimes(1);
		expect(first.continued).toBe(true);
	});

	it("runs both passes on a scheduled run that finishes", async () => {
		await run();

		expect(state.topUps).toHaveBeenCalledTimes(2);
	});
});
