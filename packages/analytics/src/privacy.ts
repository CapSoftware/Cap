export type AnalyticsStringFormat =
	| "attribution"
	| "category"
	| "hostname"
	| "identifier"
	| "timestamp";

export const PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT =
	"[PENDING] Account deletion request";

const MAX_SENSITIVE_ANALYTICS_SCAN_LENGTH = 1024;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:^|\D)\+?\d[\d ().-]{5,}\d(?:\D|$)/;
const LOCAL_PATH_PATTERN =
	/(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_PATTERN =
	/(?:Bearer\s+|(?:sk|rk|pk)_(?:live|test)_|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]/i;
const CUSTOMER_FILE_EXTENSIONS = new Set([
	"avi",
	"cap",
	"csv",
	"doc",
	"docx",
	"json",
	"log",
	"m4a",
	"mkv",
	"mov",
	"mp3",
	"mp4",
	"pdf",
	"txt",
	"wav",
	"webm",
]);
const IP_ADDRESS_PATTERN =
	/(?:^|[^\d])(?:\d{1,3}\.){3}\d{1,3}(?:[^\d]|$)|(?:^|[^0-9a-f])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?=[0-9a-f:]*::[0-9a-f:]*)(?=[0-9a-f:]*[0-9a-f])[0-9a-f:]*::[0-9a-f:]*)(?:[^0-9a-f]|$)/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;
const MIXED_RANDOM_TOKEN_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_]{20,}$/;

const isAsciiLetter = (codePoint: number) =>
	(codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122);

const isUrlSchemeCharacter = (codePoint: number) =>
	isAsciiLetter(codePoint) ||
	(codePoint >= 48 && codePoint <= 57) ||
	codePoint === 43 ||
	codePoint === 45 ||
	codePoint === 46;

function containsUrl(value: string) {
	if (value.toLowerCase().includes("www.")) return true;
	let separator = value.indexOf("://");
	while (separator >= 0) {
		let cursor = separator - 1;
		let hasLeadingLetter = false;
		while (cursor >= 0 && isUrlSchemeCharacter(value.charCodeAt(cursor))) {
			hasLeadingLetter ||= isAsciiLetter(value.charCodeAt(cursor));
			cursor -= 1;
		}
		if (hasLeadingLetter) return true;
		separator = value.indexOf("://", separator + 3);
	}
	return false;
}

function containsCustomerFilename(value: string) {
	const filenameStart =
		Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1;
	const extensionStart = value.lastIndexOf(".");
	if (extensionStart <= filenameStart) return false;
	return CUSTOMER_FILE_EXTENSIONS.has(
		value.slice(extensionStart + 1).toLowerCase(),
	);
}

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
	if (!normalized) return undefined;
	if (format === "hostname") {
		const hostname = normalized.toLowerCase();
		return !IP_ADDRESS_PATTERN.test(hostname) &&
			/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
				hostname,
			)
			? hostname
			: undefined;
	}
	if (format === "timestamp") {
		const timestamp = Date.parse(normalized);
		return Number.isFinite(timestamp) &&
			new Date(timestamp).toISOString() === normalized
			? normalized
			: undefined;
	}
	if (containsSensitiveAnalyticsContent(normalized)) return undefined;
	if (format === "identifier") {
		return SAFE_IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined;
	}
	if (format === "category") {
		return normalized.length <= 128 && SAFE_CATEGORY_PATTERN.test(normalized)
			? normalized
			: undefined;
	}
	return normalized.length <= 256 ? normalized : undefined;
}

export function containsSensitiveAnalyticsContent(value: string) {
	if (value.length > MAX_SENSITIVE_ANALYTICS_SCAN_LENGTH) return true;
	return (
		Array.from(value).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127;
		}) ||
		EMAIL_PATTERN.test(value) ||
		PHONE_PATTERN.test(value) ||
		containsUrl(value) ||
		LOCAL_PATH_PATTERN.test(value) ||
		SECRET_PATTERN.test(value) ||
		containsCustomerFilename(value) ||
		IP_ADDRESS_PATTERN.test(value)
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
