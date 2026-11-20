import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { authChallenges } from "../schema.ts";

export type AuthChallengePurpose =
	| "passkey_sign_in"
	| "passkey_step_up"
	| "passkey_registration"
	| "step_up_email_code"
	| "step_up_grant";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_CODE_TTL_MS = 10 * 60 * 1000;
export const STEP_UP_GRANT_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_CODE_MAX_ATTEMPTS = 5;
export const STEP_UP_CODE_RESEND_COOLDOWN_MS = 30 * 1000;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export function hashChallenge(value: string) {
	return crypto.createHash("sha256").update(value).digest("hex");
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

async function deleteExpiredChallenges() {
	await db()
		.delete(authChallenges)
		.where(lt(authChallenges.expiresAt, new Date()));
}

export async function storeChallenge(input: {
	purpose: Exclude<
		AuthChallengePurpose,
		"step_up_email_code" | "step_up_grant"
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
			secretHash: hashChallenge(input.challenge),
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
		"step_up_email_code" | "step_up_grant"
	>;
	challenge: string;
	userId: User.UserId | null;
}) {
	if (!input.challenge || input.challenge.length > 512) return false;
	const result = await db()
		.delete(authChallenges)
		.where(
			and(
				eq(authChallenges.secretHash, hashChallenge(input.challenge)),
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
	| { status: "cooldown"; retryAfterSeconds: number };

export async function issueStepUpCode(
	userId: User.UserId,
): Promise<StepUpCodeIssue> {
	await deleteExpiredChallenges();
	const [latest] = await db()
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

	const id = nanoId();
	const code = crypto.randomInt(100000, 1000000).toString();
	await db().transaction(async (tx) => {
		await tx
			.delete(authChallenges)
			.where(
				and(
					eq(authChallenges.userId, userId),
					eq(authChallenges.purpose, "step_up_email_code"),
				),
			);
		await tx.insert(authChallenges).values({
			id,
			userId,
			purpose: "step_up_email_code",
			secretHash: hashStepUpCode(id, code),
			expiresAt: new Date(Date.now() + STEP_UP_CODE_TTL_MS),
		});
	});
	return { status: "issued", code };
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
	if (getAffectedRows(counted) !== 1) {
		await db().delete(authChallenges).where(eq(authChallenges.id, row.id));
		return false;
	}

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
			secretHash: hashChallenge(grant),
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
				eq(authChallenges.secretHash, hashChallenge(grant)),
				eq(authChallenges.purpose, "step_up_grant"),
				eq(authChallenges.userId, userId),
				gt(authChallenges.expiresAt, new Date()),
			),
		)
		.limit(1);
	return !!row;
}
