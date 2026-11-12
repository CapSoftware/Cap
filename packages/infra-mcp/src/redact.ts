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

export function withoutQuery(url: unknown): string | null {
	if (typeof url !== "string") return null;
	const cut = url.search(/[?#]/);
	return cut < 0 ? url : url.slice(0, cut);
}
