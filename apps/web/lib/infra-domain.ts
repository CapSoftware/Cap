export type AllowedOrigin =
	| { ok: true; origin: string }
	| { ok: false; message: string };

const MAX_ORIGIN_LENGTH = 253;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const HOST_LABELS =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

const NOT_A_DOMAIN =
	"That is not a website address. Enter one like myshop.com or https://myshop.com.";

const refuse = (message: string): AllowedOrigin => ({ ok: false, message });

// The stored value has to equal the Origin header a browser sends, so it is
// reduced to scheme, host and any non-default port. A path, a query or a
// default port would never match.
export function normalizeAllowedOrigin(input: string): AllowedOrigin {
	const typed = input.trim().toLowerCase();
	if (!typed) return refuse("Enter a domain, for example myshop.com.");
	if (typed.includes("*")) {
		return refuse(
			"Wildcards are not supported. Add each subdomain on its own.",
		);
	}

	const hasScheme = SCHEME.test(typed);
	const candidate = hasScheme
		? typed
		: `${LOCAL_HOST.test(typed) ? "http" : "https"}://${typed}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return refuse(NOT_A_DOMAIN);
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return refuse(
			"Only http and https addresses can be allowed, for example https://myshop.com.",
		);
	}
	if (url.username || url.password) return refuse(NOT_A_DOMAIN);

	const host = url.hostname;
	const ipv6 = host.startsWith("[") && host.endsWith("]");
	if (!ipv6 && !HOST_LABELS.test(host)) return refuse(NOT_A_DOMAIN);
	if (!hasScheme && !host.includes(".") && host !== "localhost") {
		return refuse(NOT_A_DOMAIN);
	}
	if (url.origin.length > MAX_ORIGIN_LENGTH) {
		return refuse("That address is too long.");
	}

	return { ok: true, origin: url.origin };
}
