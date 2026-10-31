import { buildEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { accounts, users } from "../schema.ts";
import { isDisposableEmail } from "./disposable-email.ts";

/**
 * Whether a sign-in would create, or finish creating, a Cap account on a
 * throwaway inbox. People who already signed in with that address, or paid
 * for Cap with it through guest checkout, keep access; a row an organization
 * invite provisioned does not count until its owner has signed in once. This
 * is an abuse filter, not an access check: a paid subscription is never a
 * cheap way to mint accounts, so any row with Stripe billing counts.
 */
export async function isDisposableEmailSignup(email: string): Promise<boolean> {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return false;
	if (!(await isDisposableEmail(email))) return false;

	const [user] = await db()
		.select({
			id: users.id,
			emailVerified: users.emailVerified,
			stripeCustomerId: users.stripeCustomerId,
			stripeSubscriptionId: users.stripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (!user) return true;
	if (user.emailVerified || user.stripeCustomerId || user.stripeSubscriptionId)
		return false;

	const [linked] = await db()
		.select({ userId: accounts.userId })
		.from(accounts)
		.where(eq(accounts.userId, user.id))
		.limit(1);
	return !linked;
}
