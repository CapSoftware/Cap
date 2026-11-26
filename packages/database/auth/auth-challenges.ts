import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { authChallenges, users } from "../schema.ts";

export type AuthChallengePurpose =
	| "passkey_sign_in"
	| "passkey_step_up"
	| "passkey_registration"
	| "passkey_first_registration"
	| "step_up_email_code"
	| "step_up_email_code_sent"
	| "step_up_grant";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_CODE_TTL_MS = 10 * 60 * 1000;
export const STEP_UP_GRANT_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_CODE_MAX_ATTEMPTS = 3;
export const STEP_UP_CODES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
export const STEP_UP_CODE_RESEND_COOLDOWN_MS = 30 * 1000;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export function hashChallenge(purpose: AuthChallengePurpose, value: string) {
	return crypto
		.createHash("sha256")
		.update(`${purpose}:${value}`)
		.digest("hex");
}

function hashStepUpCode(challengeId: string, code: string) {
	return crypto
		.createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(`step-up-code:${challengeId}:${code}`)
		.digest("hex");
}

function sameHash(a: string, b: string) {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Best-effort cleanup. Expired rows are deleted by primary key: a range
 * delete on expiresAt takes gap locks that deadlock with other accounts'
 * inserts on MySQL 8.4.
 */
async function deleteExpiredChallenges() {
	try {
		const expired = await db()
			.select({ id: authChallenges.id })
			.from(authChallenges)
			.where(lt(authChallenges.expiresAt, new Date()))
			.limit(100);
		if (expired.length === 0) return;
		await db()
			.delete(authChallenges)
			.where(
				inArray(
					authChallenges.id,
					expired.map((row) => row.id),
				),
			);
	} catch (error) {
		console.warn("[auth] Expired challenge cleanup skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function storeChallenge(input: {
	purpose: Exclude<
		AuthChallengePurpose,
		"step_up_email_code" | "step_up_email_code_sent" | "step_up_grant"
	>;
	challenge: string;
	userId: User.UserId | null;
}) {
	await deleteExpiredChallenges();
	await db()
		.insert(authChallenges)
		.values({
			id: nanoId(),
			userId: input.userId,
			purpose: input.purpose,
			secretHash: hashChallenge(input.purpose, input.challenge),
			expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
		});
}

/**
 * Atomically claims a stored challenge. A challenge can be claimed once, only
 * for the purpose and user it was issued for, and only before it expires.
 */
export async function consumeChallenge(input: {
	purpose: Exclude<
		AuthChallengePurpose,
		"step_up_email_code" | "step_up_email_code_sent" | "step_up_grant"
	>;
	challenge: string;
	userId: User.UserId | null;
	database?: Pick<ReturnType<typeof db>, "delete">;
}) {
	if (!input.challenge || input.challenge.length > 512) return false;
	const result = await (input.database ?? db())
		.delete(authChallenges)
		.where(
			and(
				eq(
					authChallenges.secretHash,
					hashChallenge(input.purpose, input.challenge),
				),
				eq(authChallenges.purpose, input.purpose),
				input.userId
					? eq(authChallenges.userId, input.userId)
					: isNull(authChallenges.userId),
				gt(authChallenges.expiresAt, new Date()),
			),
		);
	return getAffectedRows(result) === 1;
}

export type StepUpCodeIssue =
	| { status: "issued"; code: string }
	| { status: "cooldown"; retryAfterSeconds: number }
	| { status: "daily_limit" };

export async function issueStepUpCode(
	userId: User.UserId,
): Promise<StepUpCodeIssue> {
	await deleteExpiredChallenges();
	const id = nanoId();
	const code = crypto.randomInt(100000, 1000000).toString();
	return db().transaction(async (tx): Promise<StepUpCodeIssue> => {
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		const [latest] = await tx
			.select({ expiresAt: authChallenges.expiresAt })
			.from(authChallenges)
			.where(
				and(
					eq(authChallenges.userId, userId),
					eq(authChallenges.purpose, "step_up_email_code"),
				),
			)
			.orderBy(desc(authChallenges.expiresAt))
			.limit(1);
		if (latest) {
			const elapsed =
				Date.now() - (latest.expiresAt.getTime() - STEP_UP_CODE_TTL_MS);
			if (elapsed < STEP_UP_CODE_RESEND_COOLDOWN_MS) {
				return {
					status: "cooldown",
					retryAfterSeconds: Math.ceil(
						(STEP_UP_CODE_RESEND_COOLDOWN_MS - elapsed) / 1000,
					),
				};
			}
		}
		const sentToday = await tx
			.select({ id: authChallenges.id })
			.from(authChallenges)
			.where(
				and(
					eq(authChallenges.userId, userId),
					eq(authChallenges.purpose, "step_up_email_code_sent"),
					gt(authChallenges.expiresAt, new Date()),
				),
			);
		if (sentToday.length >= STEP_UP_CODES_PER_DAY) {
			return { status: "daily_limit" };
		}
		const previous = await tx
			.select({ id: authChallenges.id })
			.from(authChallenges)
			.where(
				and(
					eq(authChallenges.userId, userId),
					eq(authChallenges.purpose, "step_up_email_code"),
				),
			);
		if (previous.length > 0) {
			await tx.delete(authChallenges).where(
				inArray(
					authChallenges.id,
					previous.map((row) => row.id),
				),
			);
		}
		const markerId = nanoId();
		await tx.insert(authChallenges).values({
			id: markerId,
			userId,
			purpose: "step_up_email_code_sent",
			secretHash: hashChallenge("step_up_email_code_sent", `${markerId}:${id}`),
			expiresAt: new Date(Date.now() + DAY_MS),
		});
		await tx.insert(authChallenges).values({
			id,
			userId,
			purpose: "step_up_email_code",
			secretHash: hashStepUpCode(id, code),
			expiresAt: new Date(Date.now() + STEP_UP_CODE_TTL_MS),
		});
		return { status: "issued", code };
	});
}

/**
 * Checks an emailed step-up code. Every guess is counted before the code is
 * compared, so concurrent guesses cannot exceed the attempt limit, and a
 * correct code is deleted with a single conditional delete so it works once.
 */
export async function verifyStepUpCode(userId: User.UserId, code: string) {
	const normalizedCode = code.trim();
	if (!/^\d{6}$/.test(normalizedCode)) return false;

	const [row] = await db()
		.select()
		.from(authChallenges)
		.where(
			and(
				eq(authChallenges.userId, userId),
				eq(authChallenges.purpose, "step_up_email_code"),
				gt(authChallenges.expiresAt, new Date()),
			),
		)
		.orderBy(desc(authChallenges.expiresAt))
		.limit(1);
	if (!row) return false;

	const counted = await db()
		.update(authChallenges)
		.set({ attempts: sql`${authChallenges.attempts} + 1` })
		.where(
			and(
				eq(authChallenges.id, row.id),
				eq(authChallenges.userId, userId),
				lt(authChallenges.attempts, STEP_UP_CODE_MAX_ATTEMPTS),
				gt(authChallenges.expiresAt, new Date()),
			),
		);
	if (getAffectedRows(counted) !== 1) return false;

	if (!sameHash(row.secretHash, hashStepUpCode(row.id, normalizedCode))) {
		return false;
	}

	const claimed = await db()
		.delete(authChallenges)
		.where(
			and(
				eq(authChallenges.id, row.id),
				eq(authChallenges.secretHash, row.secretHash),
			),
		);
	return getAffectedRows(claimed) === 1;
}

export async function issueStepUpGrant(userId: User.UserId) {
	const grant = crypto.randomBytes(32).toString("base64url");
	await db()
		.insert(authChallenges)
		.values({
			id: nanoId(),
			userId,
			purpose: "step_up_grant",
			secretHash: hashChallenge("step_up_grant", grant),
			expiresAt: new Date(Date.now() + STEP_UP_GRANT_TTL_MS),
		});
	return grant;
}

export async function hasStepUpGrant(userId: User.UserId, grant: unknown) {
	if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant)) {
		return false;
	}
	const [row] = await db()
		.select({ id: authChallenges.id })
		.from(authChallenges)
		.where(
			and(
				eq(authChallenges.secretHash, hashChallenge("step_up_grant", grant)),
				eq(authChallenges.purpose, "step_up_grant"),
				eq(authChallenges.userId, userId),
				gt(authChallenges.expiresAt, new Date()),
			),
		)
		.limit(1);
	return !!row;
}

/**
 * Spends the confirmation and every other registration challenge it minted,
 * so one confirmation adds at most one passkey.
 */
export async function spendPasskeySetup(
	userId: User.UserId,
	database: Pick<ReturnType<typeof db>, "select" | "delete">,
) {
	const rows = await database
		.select({ id: authChallenges.id })
		.from(authChallenges)
		.where(
			and(
				eq(authChallenges.userId, userId),
				inArray(authChallenges.purpose, [
					"step_up_grant",
					"passkey_registration",
					"passkey_first_registration",
				]),
			),
		);
	if (rows.length === 0) return;
	await database.delete(authChallenges).where(
		inArray(
			authChallenges.id,
			rows.map((row) => row.id),
		),
	);
}
