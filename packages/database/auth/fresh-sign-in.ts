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
