export type AnalyticsStringFormat =
	| "attribution"
	| "category"
	| "hostname"
	| "identifier";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /^\+?[\d ().-]{7,}$/;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_PATH_PATTERN =
	/^(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PATTERN =
	/^(?:Bearer\s+|(?:sk|rk|pk)_(?:live|test)_|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$)|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]/i;
const CUSTOMER_FILE_PATTERN =
	/[^/\\]+\.(?:avi|cap|csv|docx?|json|log|m4a|mkv|mov|mp3|mp4|pdf|txt|wav|webm)$/i;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;
const MIXED_RANDOM_TOKEN_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_]{20,}$/;

export function normalizeAnalyticsIdentifier(value: unknown, maxLength = 128) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > maxLength ||
		!SAFE_IDENTIFIER_PATTERN.test(normalized) ||
		containsSensitiveAnalyticsContent(normalized)
	) {
		return undefined;
	}
	return normalized;
}

export function normalizeAnalyticsPropertyString(
	value: string,
	format: AnalyticsStringFormat,
) {
	const normalized = value.trim();
	if (!normalized || containsSensitiveAnalyticsContent(normalized)) {
		return undefined;
	}
	if (format === "identifier") {
		return SAFE_IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined;
	}
	if (format === "category") {
		return normalized.length <= 128 && SAFE_CATEGORY_PATTERN.test(normalized)
			? normalized
			: undefined;
	}
	if (format === "hostname") {
		const hostname = normalized.toLowerCase();
		return !IPV4_PATTERN.test(hostname) &&
			/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
				hostname,
			)
			? hostname
			: undefined;
	}
	return normalized.length <= 256 ? normalized : undefined;
}

export function containsSensitiveAnalyticsContent(value: string) {
	return (
		Array.from(value).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127;
		}) ||
		EMAIL_PATTERN.test(value) ||
		PHONE_PATTERN.test(value) ||
		URL_PATTERN.test(value) ||
		LOCAL_PATH_PATTERN.test(value) ||
		SECRET_PATTERN.test(value) ||
		CUSTOMER_FILE_PATTERN.test(value)
	);
}

export function isSensitiveAnalyticsPathSegment(segment: string) {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {}
	return (
		containsSensitiveAnalyticsContent(decoded) ||
		decoded.includes("@") ||
		LONG_HEX_PATTERN.test(decoded) ||
		MIXED_RANDOM_TOKEN_PATTERN.test(decoded)
	);
}
