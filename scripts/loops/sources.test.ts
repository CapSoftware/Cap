import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type pg from "pg";
import { connectCapDatabase } from "../../packages/database/loops/connection";
import { profileUserQuery } from "../../packages/database/loops/sources";

const url = process.env.LOOPS_ACTIVATION_READONLY_TEST_URL;

describe.skipIf(!url)("profile source SQL preserves the previous reads", () => {
	let database: pg.Client;
	beforeAll(async () => {
		if (!url) throw new Error("Missing read-only test connection");
		database = await connectCapDatabase(url);
	});
	afterAll(async () => {
		await database?.end();
	});

	const userQuery =
		'SELECT id,email,name,"lastName","emailVerified","stripeCustomerId","stripeSubscriptionStatus","thirdPartyStripeSubscriptionId","inviteQuota",created_at,"defaultOrgId","marketingOrigin" FROM users WHERE id=$1';

	function fixtureRows(
		columns: string[],
		values: (string | null)[][],
		firstParam: number,
	) {
		let param = firstParam;
		return values.length
			? values
					.map(
						() =>
							`SELECT ${columns
								.map((column) => `$${param++}::text AS "${column}"`)
								.join(",")}`,
					)
					.join(" UNION ALL ")
			: `SELECT ${columns.map((column) => `NULL::text AS "${column}"`).join(",")} WHERE FALSE`;
	}

	for (const [name, accounts, invites] of [
		["no account or invitation", [], []],
		["OAuth signup", [["owner", "google"]], []],
		["SSO signup", [["owner", "workos"]], []],
		[
			"multiple accounts",
			[
				["owner", "google"],
				["owner", "workos"],
			],
			[],
		],
		["another user's account", [["other", "workos"]], []],
		["case-sensitive provider", [["owner", "WORKOS"]], []],
		["provider with trailing whitespace", [["owner", "workos "]], []],
		["pending invitation", [], [["person@example.com", "pending"]]],
		["accepted invitation", [], [["person@example.com", "accepted"]]],
		["declined invitation", [], [["person@example.com", "declined"]]],
		["expired invitation", [], [["person@example.com", "expired"]]],
		[
			"case-sensitive pending decision",
			[],
			[["person@example.com", "PENDING"]],
		],
		["case-insensitive email lookup", [], [["PERSON@example.com", "pending"]]],
		["another email's invitation", [], [["other@example.com", "pending"]]],
		[
			"mixed invitation states",
			[["owner", "google"]],
			[
				["person@example.com", "declined"],
				["person@example.com", "accepted"],
				["person@example.com", "pending"],
				["other@example.com", "pending"],
			],
		],
	] satisfies [string, string[][], string[][]][]) {
		for (const verified of [false, true]) {
			test(`${name}, ${verified ? "verified" : "unverified"} email`, async () => {
				const user = [
					"owner",
					"person@example.com",
					"Person",
					null,
					verified ? "2026-09-12 01:00:00" : null,
					null,
					"active",
					null,
					"3",
					"2026-09-12 01:00:00",
					"organization",
					"independent",
				];
				const userColumns = [
					"id",
					"email",
					"name",
					"lastName",
					"emailVerified",
					"stripeCustomerId",
					"stripeSubscriptionStatus",
					"thirdPartyStripeSubscriptionId",
					"inviteQuota",
					"created_at",
					"defaultOrgId",
					"marketingOrigin",
				];
				const accountsStart = 2 + user.length;
				const invitesStart = accountsStart + accounts.flat().length;
				const cte = `WITH
					users AS (${fixtureRows(userColumns, [user], 2)}),
					accounts AS (${fixtureRows(["userId", "provider"], accounts, accountsStart)}),
					organization_invites AS (${fixtureRows(["invitedEmail", "status"], invites, invitesStart)})`;
				const values = [...user, ...accounts.flat(), ...invites.flat()];
				const { rows: previousUsers } = await database.query(
					`${cte} ${userQuery}`,
					["owner", ...values],
				);
				const { rows: previousAccounts } = await database.query(
					`${cte} SELECT provider FROM accounts WHERE "userId"=$1`,
					["owner", ...values],
				);
				const { rows: previousInvites } = await database.query(
					`${cte} SELECT status FROM organization_invites WHERE lower("invitedEmail")=lower($1) AND status IN ('pending','accepted')`,
					["person@example.com", ...values],
				);
				const { rows: combined } = await database.query(
					`${cte} ${profileUserQuery}`,
					["owner", ...values],
				);
				const {
					hasAccount,
					hasWorkosAccount,
					hasInvite,
					hasPendingInvite,
					...combinedUser
				} = combined[0];
				expect(combinedUser).toEqual(previousUsers[0]);
				expect(Boolean(combinedUser.emailVerified || hasAccount)).toBe(
					Boolean(previousUsers[0].emailVerified || previousAccounts.length),
				);
				expect(Boolean(hasWorkosAccount)).toBe(
					previousAccounts.some((account) => account.provider === "workos"),
				);
				expect(Boolean(hasInvite)).toBe(previousInvites.length > 0);
				expect(Boolean(hasPendingInvite)).toBe(
					previousInvites.some((invite) => invite.status === "pending"),
				);
				const { rows: missing } = await database.query(
					`${cte} ${profileUserQuery}`,
					["missing", ...values],
				);
				expect(missing).toEqual([]);
			});
		}
	}
});
