const SECRET_KEY = /\bcsk_[A-Za-z0-9_-]{6,}/g;
const UPLOAD_TOKEN = /\bcut_[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]+)?/g;
const URL_CREDENTIAL =
	/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi;

export function createRedactor(secretKey: string) {
	return (text: string) =>
		text
			.split(secretKey)
			.join("csk_[redacted]")
			.replace(SECRET_KEY, "csk_[redacted]")
			.replace(UPLOAD_TOKEN, "cut_[redacted]")
			.replace(URL_CREDENTIAL, "$1[redacted]");
}

export class Disclosed {
	constructor(readonly value: string) {}
}

export function redactValue(
	redact: (text: string) => string,
	value: unknown,
	options: { disclose?: boolean } = {},
): unknown {
	if (value instanceof Disclosed) {
		return options.disclose ? value.value : redact(value.value);
	}
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) {
		return value.map((entry) => redactValue(redact, entry, options));
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([name, entry]) => [
				redact(name),
				redactValue(redact, entry, options),
			]),
		);
	}
	return value;
}

export function withoutQuery(url: unknown): string | null {
	if (typeof url !== "string") return null;
	const cut = url.search(/[?#]/);
	return cut < 0 ? url : url.slice(0, cut);
}
