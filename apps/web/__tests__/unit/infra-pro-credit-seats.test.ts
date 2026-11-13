import * as Db from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Member = {
	id: string;
	email: string;
	stripeSubscriptionId: string | null;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

type StripeSubscription = {
	id: string;
	status: string;
	items: { data: Array<{ quantity?: number }> };
	customer: { id: string; email: string | null; metadata: { userId?: string } };
};

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	user: null as Member | null,
	isCap: true,
	now: new Date("2026-11-12T10:00:00Z"),
	subscriptions: new Map<string, StripeSubscription>(),
	retrieve: vi.fn(),
}));

vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: mocks.db,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
	serverEnv: () => ({}),
}));
vi.mock("@cap/utils", () => ({
	userIsPro: (user?: Partial<Member> | null) =>
		!mocks.isCap ||
		Boolean(user?.thirdPartyStripeSubscriptionId) ||
		["active", "trialing", "complete", "paid", "past_due"].includes(
			user?.stripeSubscriptionStatus ?? "",
		),
	stripe: () => ({ subscriptions: { retrieve: mocks.retrieve } }),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));

const { claimDeveloperProCredit } = await import(
	"@/actions/developers/claim-pro-credit"
);

type Row = Record<string, unknown>;

const dialect = new MySqlDialect();
const render = (value: SQL | undefined) =>
	value ? dialect.sqlToQuery(value) : { sql: "", params: [] as unknown[] };

function makeDatabase(people: Member[]) {
	const accounts = people.map((person) => ({
		id: `account-${person.id}`,
		appId: `app-${person.id}`,
		ownerId: person.id,
		balanceMicroCredits: 0,
	}));
	const rows: Row[] = [];
	const locks = new Map<string, Promise<void>>();
	const locked: string[] = [];
	const ownerOf = (accountId: unknown) =>
		accounts.find((account) => account.id === accountId)?.ownerId;

	const makeClient = (held: Array<() => void> | null) => {
		const lock = async (userId: string) => {
			if (!held) return;
			locked.push(userId);
			const previous = locks.get(userId) ?? Promise.resolve();
			let release: () => void = () => {};
			locks.set(
				userId,
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			);
			held.push(release);
			await previous;
		};

		return {
			select: (fields: Record<string, unknown>) => {
				const keys = Object.keys(fields).sort().join(",");
				let table: MySqlTable;
				let condition: SQL | undefined;
				const read = (): Row[] => {
					const { sql, params } = render(condition);
					if (table === Db.users) {
						return people
							.filter((person) =>
								sql.includes("`email`")
									? person.email === params[0]
									: person.id === params[0],
							)
							.map((person) => ({ id: person.id }));
					}
					if (table === Db.developerCreditAccounts && keys === "total") {
						const [, period, subscriptionId] = params;
						return [
							{
								total: rows.filter(
									(row) =>
										row.referenceType === "pro_monthly_credit" &&
										row.referenceId === period &&
										(row.metadata as Row).subscriptionId === subscriptionId,
								).length,
							},
						];
					}
					if (table === Db.developerCreditAccounts && keys === "id") {
						const [appId, ownerId] = params;
						return accounts
							.filter(
								(account) =>
									account.appId === appId && account.ownerId === ownerId,
							)
							.map((account) => ({ id: account.id }));
					}
					if (table === Db.developerCreditAccounts) {
						return accounts.filter((account) => account.id === params[0]);
					}
					if (table === Db.developerCreditTransactions) {
						const [ownerId, , period] = params;
						return rows.filter(
							(row) =>
								ownerOf(row.accountId) === ownerId &&
								row.referenceId === period,
						);
					}
					throw new Error("Unexpected select");
				};
				const settle = () =>
					Object.assign(Promise.resolve().then(read), {
						limit: () => settle(),
						for: async () => {
							if (table === Db.users) {
								await lock(String(render(condition).params[0]));
							}
							return read();
						},
					});
				const query = {
					from: (value: MySqlTable) => {
						table = value;
						return query;
					},
					innerJoin: () => query,
					where: (value: SQL | undefined) => {
						condition = value;
						return settle();
					},
				};
				return query;
			},
			update: () => ({
				set: (values: { balanceMicroCredits: SQL }) => ({
					where: async (condition: SQL | undefined) => {
						const account = accounts.find(
							(candidate) => candidate.id === render(condition).params[0],
						);
						if (account) {
							account.balanceMicroCredits += Number(
								render(values.balanceMicroCredits).params.at(-1),
							);
						}
					},
				}),
			}),
			insert: () => ({
				values: async (value: Row) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					rows.push(value);
				},
			}),
		};
	};

	return {
		accounts,
		rows,
		locked,
		balanceOf: (person: Member) =>
			accounts.find((account) => account.ownerId === person.id)
				?.balanceMicroCredits,
		client: {
			...makeClient(null),
			transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
				const held: Array<() => void> = [];
				try {
					return await run(makeClient(held));
				} finally {
					for (const release of held) release();
				}
			},
		},
	};
}

const person = (id: string, fields: Partial<Member> = {}): Member => ({
	id,
	email: `${id}@example.com`,
	stripeSubscriptionId: null,
	stripeSubscriptionStatus: null,
	thirdPartyStripeSubscriptionId: null,
	...fields,
});

const SEATS_CLAIMED = {
	success: false,
	message:
		"This month's Cap Pro credits for your team are all claimed. There is one for each paid seat.",
};
const GRANTED = { balanceMicroCredits: 500_000 };

describe("the Cap Pro credit follows the paid seats", () => {
	let owner: Member;
	let anna: Member;
	let ben: Member;
	let cara: Member;
	let solo: Member;
	let database: ReturnType<typeof makeDatabase>;

	const team = (seats: number, status = "active") =>
		mocks.subscriptions.set("sub_team", {
			id: "sub_team",
			status,
			items: { data: [{ quantity: seats }] },
			customer: {
				id: "cus_team",
				email: owner.email,
				metadata: { userId: owner.id },
			},
		});

	const claimAs = (member: Member) => {
		mocks.user = member;
		return claimDeveloperProCredit(`app-${member.id}`);
	};

	const holdSeat = (member: Member) => {
		for (const other of [anna, ben, cara]) {
			other.thirdPartyStripeSubscriptionId =
				other === member ? "sub_team" : null;
		}
	};

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		mocks.isCap = true;
		owner = person("owner", {
			stripeSubscriptionId: "sub_team",
			stripeSubscriptionStatus: "active",
		});
		anna = person("anna");
		ben = person("ben");
		cara = person("cara");
		solo = person("solo", {
			stripeSubscriptionId: "sub_solo",
			stripeSubscriptionStatus: "active",
		});
		database = makeDatabase([owner, anna, ben, cara, solo]);
		mocks.db.mockReturnValue(database.client);
		mocks.subscriptions = new Map();
		team(1);
		mocks.subscriptions.set("sub_solo", {
			id: "sub_solo",
			status: "active",
			items: { data: [{ quantity: 1 }] },
			customer: { id: "cus_solo", email: solo.email, metadata: {} },
		});
		mocks.retrieve.mockReset();
		mocks.retrieve.mockImplementation(async (id: string) => {
			const subscription = mocks.subscriptions.get(id);
			if (!subscription) throw new Error("No such subscription");
			return subscription;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("grants one claim a month when one seat is rotated across three members", async () => {
		holdSeat(anna);
		expect(await claimAs(anna)).toEqual(GRANTED);
		holdSeat(ben);
		expect(await claimAs(ben)).toEqual(SEATS_CLAIMED);
		holdSeat(cara);
		expect(await claimAs(cara)).toEqual(SEATS_CLAIMED);

		expect(database.rows).toHaveLength(1);
		expect(database.balanceOf(anna)).toBe(500_000);
		expect(database.balanceOf(ben)).toBe(0);
		expect(database.balanceOf(cara)).toBe(0);
	});

	it("counts the owner's own claim against the same seat", async () => {
		expect(await claimAs(owner)).toEqual(GRANTED);
		holdSeat(anna);
		expect(await claimAs(anna)).toEqual(SEATS_CLAIMED);
		expect(database.rows).toHaveLength(1);
	});

	it("grants two claims a month on a two-seat subscription", async () => {
		team(2);

		holdSeat(anna);
		expect(await claimAs(anna)).toEqual(GRANTED);
		holdSeat(ben);
		expect(await claimAs(ben)).toEqual(GRANTED);
		holdSeat(cara);
		expect(await claimAs(cara)).toEqual(SEATS_CLAIMED);

		expect(database.rows).toHaveLength(2);
	});

	it("grants one when two members claim through one seat at the same moment", async () => {
		anna.thirdPartyStripeSubscriptionId = "sub_team";
		ben.thirdPartyStripeSubscriptionId = "sub_team";
		mocks.user = anna;
		const first = claimDeveloperProCredit("app-anna");
		mocks.user = ben;
		const second = claimDeveloperProCredit("app-ben");
		mocks.user = null;

		const results = await Promise.all([first, second]);

		expect(
			results.filter((result) => "balanceMicroCredits" in result),
		).toHaveLength(1);
		expect(results.filter((result) => "success" in result)).toEqual([
			SEATS_CLAIMED,
		]);
		expect(database.rows).toHaveLength(1);
		expect(database.locked.filter((id) => id === "owner")).toHaveLength(2);
	});

	it("opens the seat again the next month", async () => {
		holdSeat(anna);
		await claimAs(anna);
		holdSeat(ben);
		expect(await claimAs(ben)).toEqual(SEATS_CLAIMED);

		vi.setSystemTime(new Date("2026-12-01T00:00:01Z"));
		expect(await claimAs(ben)).toEqual(GRANTED);
		holdSeat(anna);
		expect(await claimAs(anna)).toEqual(SEATS_CLAIMED);
	});

	it("leaves a direct subscriber unaffected", async () => {
		holdSeat(anna);
		await claimAs(anna);

		expect(await claimAs(solo)).toEqual(GRANTED);
		expect(await claimAs(solo)).toEqual({
			success: false,
			message:
				"This month's credit is already claimed. It is one per account, not one per app.",
		});
		expect(database.balanceOf(solo)).toBe(500_000);
		expect(database.locked.filter((id) => id === "solo")).toHaveLength(2);
		expect(database.rows.at(-1)).toMatchObject({
			type: "pro_credit",
			referenceId: "2026-11",
			referenceType: "pro_monthly_credit",
			metadata: { period: "2026-11", subscriptionId: "sub_solo", seats: 1 },
		});
	});

	it("records the paying subscription on a member's claim", async () => {
		holdSeat(anna);
		await claimAs(anna);

		expect(database.rows[0]).toMatchObject({
			accountId: "account-anna",
			referenceId: "2026-11",
			metadata: { subscriptionId: "sub_team", seats: 1 },
		});
	});

	it("refuses a member whose team subscription is still on a trial", async () => {
		team(1, "trialing");
		holdSeat(anna);

		expect(await claimAs(anna)).toEqual({
			success: false,
			message:
				"Your $5 monthly Infra credit starts with your first paid month of Cap Pro.",
		});
		expect(database.rows).toHaveLength(0);
	});

	it("still grants while the subscription is past due", async () => {
		team(1, "past_due");
		holdSeat(anna);

		expect(await claimAs(anna)).toEqual(GRANTED);
	});

	it("refuses a seat whose subscription has ended", async () => {
		team(1, "canceled");
		holdSeat(anna);

		expect(await claimAs(anna)).toEqual({
			success: false,
			message: "This credit comes with Cap Pro.",
		});
		expect(database.rows).toHaveLength(0);
	});

	it("grants nothing when the subscription cannot be read", async () => {
		mocks.retrieve.mockRejectedValue(new Error("network"));
		holdSeat(anna);

		expect(await claimAs(anna)).toEqual({
			success: false,
			message:
				"Could not check your Cap Pro subscription. Try again in a moment.",
		});
		expect(database.rows).toHaveLength(0);
	});

	it("finds the payer by email when the customer carries no user id", async () => {
		const subscription = mocks.subscriptions.get("sub_team");
		if (subscription) subscription.customer.metadata = {};
		holdSeat(anna);

		expect(await claimAs(anna)).toEqual(GRANTED);
		expect(database.locked).toEqual(["owner", "anna"]);
	});

	it("does not ask Stripe on a self-hosted install", async () => {
		mocks.isCap = false;

		expect(await claimAs(anna)).toEqual(GRANTED);
		expect(mocks.retrieve).not.toHaveBeenCalled();
		expect(database.rows[0]).toMatchObject({ metadata: { period: "2026-11" } });
	});
});
