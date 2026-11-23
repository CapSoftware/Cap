import { getCsrfToken, getSession } from "next-auth/react";

export type PasskeySignInResult =
	| "signed_in"
	| "not_linked"
	| "blocked"
	| "rate_limited"
	| "failed";

export async function completePasskeySignIn(
	response: string,
	callbackUrl: string,
): Promise<PasskeySignInResult> {
	const csrfToken = await getCsrfToken();
	if (!csrfToken) return "failed";
	const result = await fetch("/api/auth/callback/passkey", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			response,
			csrfToken,
			callbackUrl,
			json: "true",
		}),
	});
	if (result.status === 429) return "rate_limited";
	const data = (await result.json().catch(() => null)) as {
		url?: unknown;
	} | null;
	if (typeof data?.url !== "string") return "failed";
	const url = new URL(data.url, window.location.origin);
	const error = url.searchParams.get("error");
	if (error === "SignupBlocked" || error === "DisposableEmail") {
		return "blocked";
	}
	if (error === "CredentialsSignin") return "not_linked";
	if (error || url.searchParams.has("csrf")) return "failed";
	const session = await getSession();
	return session?.user ? "signed_in" : "failed";
}
