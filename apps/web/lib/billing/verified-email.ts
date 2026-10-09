// These claims come only from provider tokens already verified by NextAuth and stored in the account table.
export function hasVerifiedProviderEmail(
	email: string,
	account: {
		provider: string;
		providerAccountId: string;
		idToken: string | null;
	},
) {
	if (!account.idToken) return false;
	try {
		const encoded = account.idToken.split(".")[1];
		if (!encoded) return false;
		const claims: unknown = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		);
		if (!claims || typeof claims !== "object") return false;
		const expectedIssuers =
			account.provider === "google"
				? ["https://accounts.google.com", "accounts.google.com"]
				: account.provider === "apple"
					? ["https://appleid.apple.com"]
					: [];
		return (
			"iss" in claims &&
			typeof claims.iss === "string" &&
			expectedIssuers.includes(claims.iss) &&
			"sub" in claims &&
			claims.sub === account.providerAccountId &&
			"email" in claims &&
			typeof claims.email === "string" &&
			claims.email.toLowerCase() === email.toLowerCase() &&
			"email_verified" in claims &&
			(claims.email_verified === true || claims.email_verified === "true")
		);
	} catch {
		return false;
	}
}
