import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { profileUserQuery } from "../../packages/database/loops/sources";

const url = process.env.LOOPS_ACTIVATION_READONLY_TEST_URL;

describe.skipIf(!url)("profile source SQL preserves the previous reads", () => {
	let database: Connection;
	beforeAll(async () => {
		if (!url) throw new Error("Missing read-only test connection");
		database = await mysql.createConnection({
			uri: url,
			dateStrings: true,
			timezone: "Z",
		});
	});
	afterAll(async () => {
		await database?.end();
	});

	const userQuery =
		"SELECT id,email,name,lastName,emailVerified,stripeCustomerId,stripeSubscriptionStatus,thirdPartyStripeSubscriptionId,created_at,defaultOrgId,marketingOrigin FROM users WHERE id=?";

	function fixtureRows(columns: string[], values: (string | null)[][]) {
		return values.length
			? values
					.map(
						() =>
							`SELECT ${columns
								.map(
									(column) =>
										`CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_0900_ai_ci AS ${column}`,
								)
								.join(",")}`,
					)
					.join(" UNION ALL ")
			: `SELECT ${columns.map((column) => `NULL AS ${column}`).join(",")} WHERE FALSE`;
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
					"2026-09-12 01:00:00",
					"organization",
					"independent",
				];
				const cte = `WITH
					users AS (${fixtureRows(
						[
							"id",
							"email",
							"name",
							"lastName",
							"emailVerified",
							"stripeCustomerId",
							"stripeSubscriptionStatus",
							"thirdPartyStripeSubscriptionId",
							"created_at",
							"defaultOrgId",
							"marketingOrigin",
						],
						[user],
					)}),
					accounts AS (${fixtureRows(["userId", "provider"], accounts)}),
					organization_invites AS (${fixtureRows(["invitedEmail", "status"], invites)})`;
				const values = [...user, ...accounts.flat(), ...invites.flat()];
				const [previousUsers] = await database.query<RowDataPacket[]>(
					`${cte} ${userQuery}`,
					[...values, "owner"],
				);
				const [previousAccounts] = await database.query<RowDataPacket[]>(
					`${cte} SELECT provider FROM accounts WHERE userId=?`,
					[...values, "owner"],
				);
				const [previousInvites] = await database.query<RowDataPacket[]>(
					`${cte} SELECT status FROM organization_invites WHERE invitedEmail=? AND status IN ('pending','accepted')`,
					[...values, "person@example.com"],
				);
				const [combined] = await database.query<RowDataPacket[]>(
					`${cte} ${profileUserQuery}`,
					[...values, "owner"],
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
				const [missing] = await database.query<RowDataPacket[]>(
					`${cte} ${profileUserQuery}`,
					[...values, "missing"],
				);
				expect(missing).toEqual([]);
			});
		}
	}
});
