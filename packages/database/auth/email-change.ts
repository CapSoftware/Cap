import crypto from "node:crypto";
import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_AVAILABLE, stripe } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { and, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { enqueueLoopsSync } from "../loops/queue.ts";
import {
	accounts,
	authChallenges,
	directoryUsers,
	emailChangeRequests,
	sessions,
	users,
} from "../schema.ts";
import { isDisposableEmail } from "./disposable-email.ts";
import {
	isEmailAllowedForSignup,
	isEmailBlockedFromSignup,
	normalizeSignInEmail,
} from "./domain-utils.ts";

export const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CHANGE_MAX_ATTEMPTS = 5;
export const EMAIL_CHANGE_RESEND_COOLDOWN_MS = 30 * 1000;

export type EmailChangeRefusal = "invalid" | "same" | "not_allowed" | "managed";

export type EmailChangeRequestResult =
	| { status: "issued"; email: string; code: string }
	| { status: "cooldown"; retryAfterSeconds: number }
	| { status: EmailChangeRefusal };

export type EmailChangeConfirmResult =
	| { status: "changed"; email: string; previousEmail: string }
	| { status: "invalid" | "taken" | "not_allowed" | "managed" | "failed" };

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

function hashCode(requestId: string, newEmail: string, code: string) {
	return crypto
		.createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(`email-change:${requestId}:${newEmail}:${code}`)
		.digest("hex");
}

function sameHash(a: string, b: string) {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isDuplicateKeyError(error: unknown) {
	let current: unknown = error;
	for (let depth = 0; current && depth < 4; depth++) {
		if (
			typeof current === "object" &&
			(current as { code?: unknown }).code === "ER_DUP_ENTRY"
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Accounts whose address is owned by an identity provider cannot change it
 * here: SSO sign-in requires the account email to equal the IdP's email, and
 * directory sync matches people by address.
 */
export async function isEmailManagedByOrganization(userId: User.UserId) {
	const [[ssoAccount], [directoryUser]] = await Promise.all([
		db()
			.select({ id: accounts.id })
			.from(accounts)
			.where(and(eq(accounts.userId, userId), eq(accounts.provider, "workos")))
			.limit(1),
		db()
			.select({ id: directoryUsers.id })
			.from(directoryUsers)
			.where(
				and(eq(directoryUsers.userId, userId), eq(directoryUsers.active, true)),
			)
			.limit(1),
	]);
	return Boolean(ssoAccount || directoryUser);
}

async function checkNewEmail(
	raw: unknown,
	currentEmail: string,
): Promise<{ email: string } | { status: EmailChangeRefusal }> {
	const email = normalizeSignInEmail(raw);
	if (!email || email.length > 255) return { status: "invalid" };
	if (email === currentEmail.trim().toLowerCase()) return { status: "same" };
	const env = serverEnv();
	if (isEmailBlockedFromSignup(email, env.CAP_BLOCKED_SIGNUP_DOMAINS)) {
		return { status: "not_allowed" };
	}
	if (
		env.CAP_ALLOWED_SIGNUP_DOMAINS &&
		!isEmailAllowedForSignup(email, env.CAP_ALLOWED_SIGNUP_DOMAINS)
	) {
		return { status: "not_allowed" };
	}
	if (
		buildEnv.NEXT_PUBLIC_IS_CAP === "true" &&
		(await isDisposableEmail(email))
	) {
		return { status: "not_allowed" };
	}
	return { email };
}

export async function requestEmailChange(
	user: { id: User.UserId; email: string },
	rawEmail: unknown,
): Promise<EmailChangeRequestResult> {
	if (await isEmailManagedByOrganization(user.id)) return { status: "managed" };
	const checked = await checkNewEmail(rawEmail, user.email);
	if ("status" in checked) return checked;

	await db()
		.delete(emailChangeRequests)
		.where(lt(emailChangeRequests.expiresAt, new Date()));
	const id = nanoId();
	const code = crypto.randomInt(100000, 1000000).toString();
	return db().transaction(async (tx): Promise<EmailChangeRequestResult> => {
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, user.id))
			.for("update");
		const [latest] = await tx
			.select({ expiresAt: emailChangeRequests.expiresAt })
			.from(emailChangeRequests)
			.where(eq(emailChangeRequests.userId, user.id))
			.orderBy(desc(emailChangeRequests.expiresAt))
			.limit(1);
		if (latest) {
			const elapsed =
				Date.now() - (latest.expiresAt.getTime() - EMAIL_CHANGE_CODE_TTL_MS);
			if (elapsed < EMAIL_CHANGE_RESEND_COOLDOWN_MS) {
				return {
					status: "cooldown",
					retryAfterSeconds: Math.ceil(
						(EMAIL_CHANGE_RESEND_COOLDOWN_MS - elapsed) / 1000,
					),
				};
			}
		}
		await tx
			.delete(emailChangeRequests)
			.where(eq(emailChangeRequests.userId, user.id));
		await tx.insert(emailChangeRequests).values({
			id,
			userId: user.id,
			newEmail: checked.email,
			codeHash: hashCode(id, checked.email, code),
			expiresAt: new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS),
		});
		return { status: "issued", email: checked.email, code };
	});
}

async function syncStripeCustomerEmail(
	user: { id: User.UserId; stripeCustomerId: string | null },
	email: string,
) {
	if (!user.stripeCustomerId || !STRIPE_AVAILABLE()) return;
	await stripe().customers.update(
		user.stripeCustomerId,
		{ email, metadata: { userId: user.id } },
		{ idempotencyKey: `cap-email-change-${user.id}-${email}` },
	);
}

/**
 * Applies a pending email change once the code sent to the new address is
 * confirmed. Every guess is counted before comparing, the request is claimed
 * in the same transaction that changes the email, and every existing session
 * is signed out by bumping the session version.
 */
export async function confirmEmailChange(
	userId: User.UserId,
	code: unknown,
): Promise<EmailChangeConfirmResult> {
	if (typeof code !== "string") return { status: "invalid" };
	const normalizedCode = code.trim();
	if (!/^\d{6}$/.test(normalizedCode)) return { status: "invalid" };

	const [request] = await db()
		.select()
		.from(emailChangeRequests)
		.where(
			and(
				eq(emailChangeRequests.userId, userId),
				gt(emailChangeRequests.expiresAt, new Date()),
			),
		)
		.orderBy(desc(emailChangeRequests.expiresAt))
		.limit(1);
	if (!request) return { status: "invalid" };

	const counted = await db()
		.update(emailChangeRequests)
		.set({ attempts: sql`${emailChangeRequests.attempts} + 1` })
		.where(
			and(
				eq(emailChangeRequests.id, request.id),
				eq(emailChangeRequests.userId, userId),
				lt(emailChangeRequests.attempts, EMAIL_CHANGE_MAX_ATTEMPTS),
				gt(emailChangeRequests.expiresAt, new Date()),
			),
		);
	if (getAffectedRows(counted) !== 1) {
		await db()
			.delete(emailChangeRequests)
			.where(eq(emailChangeRequests.id, request.id));
		return { status: "invalid" };
	}
	if (
		!sameHash(
			request.codeHash,
			hashCode(request.id, request.newEmail, normalizedCode),
		)
	) {
		return { status: "invalid" };
	}

	const [user] = await db()
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return { status: "invalid" };
	if (await isEmailManagedByOrganization(userId)) return { status: "managed" };
	const checked = await checkNewEmail(request.newEmail, user.email);
	if ("status" in checked || checked.email !== request.newEmail) {
		return {
			status:
				"status" in checked && checked.status === "not_allowed"
					? "not_allowed"
					: "invalid",
		};
	}

	const [owner] = await db()
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.email, request.newEmail), ne(users.id, userId)))
		.limit(1);
	if (owner) return { status: "taken" };

	try {
		await syncStripeCustomerEmail(user, request.newEmail);
	} catch (error) {
		console.error("[email-change] Failed to update the Stripe customer", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "failed" };
	}

	try {
		const changed = await db().transaction(async (tx) => {
			const claimed = await tx
				.delete(emailChangeRequests)
				.where(
					and(
						eq(emailChangeRequests.id, request.id),
						eq(emailChangeRequests.codeHash, request.codeHash),
					),
				);
			if (getAffectedRows(claimed) !== 1) return false;
			const [locked] = await tx
				.select({ email: users.email })
				.from(users)
				.where(eq(users.id, userId))
				.for("update");
			if (!locked || locked.email !== user.email) return false;
			await tx
				.update(users)
				.set({
					email: request.newEmail,
					emailVerified: new Date(),
					authSessionVersion: sql`${users.authSessionVersion} + 1`,
				})
				.where(eq(users.id, userId));
			await tx
				.delete(emailChangeRequests)
				.where(eq(emailChangeRequests.userId, userId));
			await tx.delete(sessions).where(eq(sessions.userId, userId));
			await tx.delete(authChallenges).where(eq(authChallenges.userId, userId));
			await enqueueLoopsSync(tx, userId);
			return true;
		});
		if (!changed) return { status: "invalid" };
	} catch (error) {
		if (isDuplicateKeyError(error)) return { status: "taken" };
		throw error;
	}

	return {
		status: "changed",
		email: request.newEmail,
		previousEmail: user.email,
	};
}
