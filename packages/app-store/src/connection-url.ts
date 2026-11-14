const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type ConnectionUrlProblem =
	| "invalid"
	| "https_required"
	| "credentials"
	| "port"
	| "query_or_fragment"
	| "trailing_slash"
	| "not_public";

export const CONNECTION_URL_PROBLEM_MESSAGES: Record<
	ConnectionUrlProblem,
	string
> = {
	invalid: "is not a valid URL",
	https_required: "must start with https://",
	credentials: "must not contain a username or password",
	port: "must use the default https port",
	query_or_fragment: "must not contain a query string or fragment",
	trailing_slash: "must not end with a slash",
	not_public: "must use a public hostname, not an IP address or local name",
};

export function connectionUrlProblem(
	value: string,
): ConnectionUrlProblem | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "invalid";
	}
	if (url.protocol !== "https:") return "https_required";
	if (url.username || url.password) return "credentials";
	if (url.port !== "") return "port";
	if (url.search || url.hash || value.includes("?") || value.includes("#"))
		return "query_or_fragment";
	if (value.endsWith("/")) return "trailing_slash";
	const host = url.hostname.toLowerCase();
	if (
		IPV4.test(host) ||
		host.startsWith("[") ||
		!host.includes(".") ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".test") ||
		host.endsWith(".example") ||
		host.endsWith(".invalid")
	)
		return "not_public";
	return null;
}

export const connectionEndpoint = (
	baseUrl: string,
	kind: "lifecycle" | "events" | { action: string },
) =>
	typeof kind === "string"
		? `${baseUrl}/${kind}`
		: `${baseUrl}/actions/${encodeURIComponent(kind.action)}`;
