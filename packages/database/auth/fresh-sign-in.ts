export const FRESH_SIGN_IN_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 60;

export function signInTimestamp(now = Date.now()) {
	return Math.floor(now / 1000);
}

/**
 * Whether a session's sign-in happened in the last ten minutes. The time is
 * stamped into the encrypted session token when someone signs in, so a client
 * cannot set it.
 */
export function isFreshSignIn(authTime: unknown, now = Date.now()) {
	if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
	const nowSeconds = signInTimestamp(now);
	return (
		authTime <= nowSeconds + CLOCK_SKEW_SECONDS &&
		nowSeconds - authTime <= FRESH_SIGN_IN_SECONDS
	);
}

type SignInSession = {
	user?: { id?: string };
	authTime?: unknown;
	authMethod?: unknown;
} | null;

/**
 * Whether this session may add the account's first passkey without a code:
 * the same account, signed in within the last ten minutes, by a method other
 * than a passkey. A passkey sign-in proves the account already had a passkey,
 * so it must never reopen the no-code route after that passkey is removed.
 * Sessions without a recorded method are refused.
 */
export function canAddFirstPasskeyWithoutCode(
	session: unknown,
	userId: string,
	now = Date.now(),
) {
	const current = session as SignInSession;
	return (
		current?.user?.id === userId &&
		typeof current.authMethod === "string" &&
		current.authMethod !== "passkey" &&
		isFreshSignIn(current.authTime, now)
	);
}
