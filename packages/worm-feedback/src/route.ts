import type { RouteRule } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d{3,}$/;
const TOKENISH = /^[A-Za-z0-9_~.-]{16,}$/;

function segment(value: string): string {
	let decoded = value;
	try {
		decoded = decodeURIComponent(value);
	} catch {}
	if (!decoded) return value;
	if (decoded.includes("@")) return ":email";
	if (UUID.test(decoded) || NUMBER.test(decoded)) return ":id";
	if (TOKENISH.test(decoded) && /\d/.test(decoded) && /[A-Za-z]/.test(decoded))
		return ":token";
	return value.length > 80 ? ":token" : value;
}

export function sanitizePath(path: string, rules: RouteRule[] = []): string {
	const bare = path.split(/[?#]/, 1)[0] || "/";
	let result = bare.split("/").map(segment).join("/");
	for (const rule of rules) result = result.replace(rule.pattern, rule.replace);
	return result.slice(0, 300);
}

export function sanitizeUrl(
	value: string,
	base: string,
	rules: RouteRule[] = [],
): string {
	try {
		const url = new URL(value, base);
		const path = sanitizePath(url.pathname, rules);
		return url.origin === new URL(base).origin ? path : `${url.host}${path}`;
	} catch {
		return "";
	}
}
