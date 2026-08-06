export const parseAuthRedirect = (url: string) => {
	const parsed = new URL(url);
	const error = parsed.searchParams.get("error_description");
	if (error) throw new Error(error);

	const apiKey = parsed.searchParams.get("api_key");
	const userId = parsed.searchParams.get("user_id");

	if (!apiKey || !userId) return null;
	return {
		apiKey,
		userId,
	};
};

export const requireAuthRedirectSession = (url: string) => {
	const session = parseAuthRedirect(url);
	if (!session) throw new Error("Sign in did not return a mobile session.");
	return session;
};
