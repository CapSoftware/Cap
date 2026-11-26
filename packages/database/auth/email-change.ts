import crypto from "node:crypto";
import { domainToUnicode } from "node:url";
import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_AVAILABLE, stripe } from "@cap/utils";
import type { User } from "@cap/web-domain";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	sql,
} from "drizzle-orm";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { enqueueLoopsSync } from "../loops/queue.ts";
import {
	accounts,
	authChallenges,
	directoryUsers,
	emailChangeRequests,
	organizationInvites,
	organizationMembers,
	organizations,
	sessions,
	users,
} from "../schema.ts";
import { isDisposableEmail } from "./disposable-email.ts";
import {
	isEmailAllowedForSignup,
	isEmailBlockedFromSignup,
	normalizeSignInEmail,
} from "./domain-utils.ts";
import { getSsoEmailDomain, getWorkOS, normalizeSsoDomain } from "./sso.ts";

export const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CHANGE_MAX_ATTEMPTS = 1;
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

function storedSpellings(email: string) {
	const at = email.lastIndexOf("@");
	if (at < 1 || !email.includes("xn--", at)) return [email];
	const unicodeDomain = domainToUnicode(email.slice(at + 1));
	if (!unicodeDomain) return [email];
	const unicodeEmail = `${email.slice(0, at)}@${unicodeDomain}`;
	return unicodeEmail === email ? [email] : [email, unicodeEmail];
}

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
async function isEmailManagedLocally(
	user: { id: User.UserId; email: string },
	database: Pick<ReturnType<typeof db>, "select">,
) {
	const env = serverEnv();
	if (
		env.TRUSTED_PROXY_AUTH_HEADER &&
		env.TRUSTED_PROXY_AUTH_SECRET?.trim() &&
		env.TRUSTED_PROXY_AUTH_EMAIL?.trim().toLowerCase() ===
			user.email.trim().toLowerCase()
	) {
		return true;
	}
	const [[ssoAccount], [directoryUser]] = await Promise.all([
		database
			.select({ id: accounts.id })
			.from(accounts)
			.where(and(eq(accounts.userId, user.id), eq(accounts.provider, "workos")))
			.limit(1),
		database
			.select({ id: directoryUsers.id })
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.userId, user.id),
					eq(directoryUsers.active, true),
				),
			)
			.limit(1),
	]);
	return Boolean(ssoAccount || directoryUser);
}

/**
 * Whether the address is on a domain an organization the person belongs to
 * has verified for SSO. Such members may never have signed in through SSO,
 * so this is checked against WorkOS rather than linked accounts. Leaving the
 * corporate address would otherwise keep their access after offboarding.
 */
async function isEmailOnMemberOrganizationSsoDomain(user: {
	id: User.UserId;
	email: string;
}) {
	const domain = getSsoEmailDomain(user.email);
	if (!domain) return false;
	const ssoOrganizations = await db()
		.selectDistinct({
			workosOrganizationId: organizations.workosOrganizationId,
		})
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizations.id, organizationMembers.organizationId),
		)
		.where(
			and(
				eq(organizationMembers.userId, user.id),
				isNotNull(organizations.workosOrganizationId),
				isNull(organizations.tombstoneAt),
			),
		);
	if (ssoOrganizations.length === 0) return false;
	const workos = getWorkOS();
	for (const { workosOrganizationId } of ssoOrganizations) {
		if (!workosOrganizationId) continue;
		const organization =
			await workos.organizations.getOrganization(workosOrganizationId);
		if (
			organization.domains.some(
				(entry) =>
					entry.state === "verified" &&
					normalizeSsoDomain(entry.domain) === domain,
			)
		) {
			return true;
		}
	}
	return false;
}

export async function isEmailManagedByOrganization(user: {
	id: User.UserId;
	email: string;
}) {
	return (
		(await isEmailManagedLocally(user, db())) ||
		(await isEmailOnMemberOrganizationSsoDomain(user))
	);
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

/**
 * Best-effort cleanup. Expired rows are deleted by primary key: a range
 * delete on expiresAt takes gap locks that deadlock with other accounts'
 * inserts on MySQL 8.4.
 */
async function deleteExpiredRequests() {
	try {
		const expired = await db()
			.select({ id: emailChangeRequests.id })
			.from(emailChangeRequests)
			.where(lt(emailChangeRequests.expiresAt, new Date()))
			.limit(100);
		if (expired.length === 0) return;
		await db()
			.delete(emailChangeRequests)
			.where(
				inArray(
					emailChangeRequests.id,
					expired.map((row) => row.id),
				),
			);
	} catch (error) {
		console.warn("[email-change] Expired request cleanup skipped", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function requestEmailChange(
	user: { id: User.UserId; email: string },
	rawEmail: unknown,
): Promise<EmailChangeRequestResult> {
	if (await isEmailManagedByOrganization(user)) return { status: "managed" };
	const checked = await checkNewEmail(rawEmail, user.email);
	if ("status" in checked) return checked;

	await deleteExpiredRequests();
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
		const previous = await tx
			.select({ id: emailChangeRequests.id })
			.from(emailChangeRequests)
			.where(eq(emailChangeRequests.userId, user.id));
		if (previous.length > 0) {
			await tx.delete(emailChangeRequests).where(
				inArray(
					emailChangeRequests.id,
					previous.map((row) => row.id),
				),
			);
		}
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

function isMissingStripeCustomer(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "resource_missing"
	);
}

async function setStripeCustomerEmail(
	user: { id: User.UserId; stripeCustomerId: string | null },
	email: string,
) {
	if (!user.stripeCustomerId || !STRIPE_AVAILABLE()) return false;
	try {
		await stripe().customers.update(user.stripeCustomerId, {
			email,
			metadata: { userId: user.id },
		});
		return true;
	} catch (error) {
		if (isMissingStripeCustomer(error)) return false;
		throw error;
	}
}

async function restoreStripeCustomerEmail(user: {
	id: User.UserId;
	stripeCustomerId: string | null;
}) {
	try {
		const [current] = await db()
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);
		if (!current) return;
		await setStripeCustomerEmail(user, current.email);
	} catch (error) {
		console.error("[email-change] Failed to restore the Stripe customer", {
			userId: user.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function pendingEmailChangeAddress(userId: User.UserId) {
	const [request] = await db()
		.select({ newEmail: emailChangeRequests.newEmail })
		.from(emailChangeRequests)
		.where(
			and(
				eq(emailChangeRequests.userId, userId),
				gt(emailChangeRequests.expiresAt, new Date()),
			),
		)
		.orderBy(desc(emailChangeRequests.expiresAt))
		.limit(1);
	return request?.newEmail ?? null;
}

/**
 * Applies a pending email change once the code sent to the new address is
 * confirmed. Every guess is counted before comparing, the request is claimed
 * in the same transaction that changes the email, and every web session is
 * signed out by bumping the session version. Stripe is updated first, because
 * webhooks and sign-up fall back to matching customers by email, and is put
 * back if the change does not commit.
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
	if (getAffectedRows(counted) !== 1) return { status: "invalid" };
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
	if (await isEmailManagedByOrganization(user)) return { status: "managed" };
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
		.where(
			and(
				inArray(users.email, storedSpellings(request.newEmail)),
				ne(users.id, userId),
			),
		)
		.limit(1);
	if (owner) return { status: "taken" };

	let stripeUpdated: boolean;
	try {
		stripeUpdated = await setStripeCustomerEmail(user, request.newEmail);
	} catch (error) {
		console.error("[email-change] Failed to update the Stripe customer", {
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
		await db()
			.update(emailChangeRequests)
			.set({ attempts: sql`${emailChangeRequests.attempts} - 1` })
			.where(
				and(
					eq(emailChangeRequests.id, request.id),
					gt(emailChangeRequests.attempts, 0),
				),
			);
		return { status: "failed" };
	}

	let outcome: "changed" | "invalid" | "managed" | "taken";
	try {
		outcome = await db().transaction(async (tx) => {
			const [locked] = await tx
				.select({
					email: users.email,
					authSessionVersion: users.authSessionVersion,
				})
				.from(users)
				.where(eq(users.id, userId))
				.for("update");
			if (
				!locked ||
				locked.email !== user.email ||
				locked.authSessionVersion !== user.authSessionVersion
			) {
				return "invalid";
			}
			if (await isEmailManagedLocally(user, tx)) return "managed";
			const claimed = await tx
				.delete(emailChangeRequests)
				.where(
					and(
						eq(emailChangeRequests.id, request.id),
						eq(emailChangeRequests.codeHash, request.codeHash),
					),
				);
			if (getAffectedRows(claimed) !== 1) return "invalid";
			await tx
				.update(users)
				.set({
					email: request.newEmail,
					emailVerified: new Date(),
					authSessionVersion: sql`${users.authSessionVersion} + 1`,
				})
				.where(eq(users.id, userId));
			const pending = await tx
				.select({ id: emailChangeRequests.id })
				.from(emailChangeRequests)
				.where(eq(emailChangeRequests.userId, userId));
			if (pending.length > 0) {
				await tx.delete(emailChangeRequests).where(
					inArray(
						emailChangeRequests.id,
						pending.map((row) => row.id),
					),
				);
			}
			const challenges = await tx
				.select({ id: authChallenges.id })
				.from(authChallenges)
				.where(eq(authChallenges.userId, userId));
			if (challenges.length > 0) {
				await tx.delete(authChallenges).where(
					inArray(
						authChallenges.id,
						challenges.map((row) => row.id),
					),
				);
			}
			const oldAddressInvites = await tx
				.select({
					id: organizationInvites.id,
					invitedEmail: organizationInvites.invitedEmail,
				})
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.invitedEmail, user.email),
						eq(organizationInvites.status, "pending"),
					),
				);
			const staleInviteIds = oldAddressInvites
				.filter(
					(invite) =>
						invite.invitedEmail.toLowerCase() === user.email.toLowerCase(),
				)
				.map((invite) => invite.id);
			if (staleInviteIds.length > 0) {
				await tx
					.delete(organizationInvites)
					.where(inArray(organizationInvites.id, staleInviteIds));
			}
			await tx.delete(sessions).where(eq(sessions.userId, userId));
			await enqueueLoopsSync(tx, userId);
			return "changed";
		});
	} catch (error) {
		if (stripeUpdated) await restoreStripeCustomerEmail(user);
		if (isDuplicateKeyError(error)) return { status: "taken" };
		throw error;
	}
	if (outcome !== "changed") {
		if (stripeUpdated) await restoreStripeCustomerEmail(user);
		return { status: outcome };
	}

	return {
		status: "changed",
		email: request.newEmail,
		previousEmail: user.email,
	};
}
