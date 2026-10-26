const MAX_LOG_REASON_LENGTH = 300;

const REDACTIONS: [RegExp, string][] = [
	[/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
	[/\b[\w.-]+\.amazonaws\.com\S*/gi, "<url>"],
	[/X-Amz-[A-Za-z-]+=[^\s&]*/gi, "<redacted>"],
	[/\?[^\s?=]+=\S*/g, "?<redacted>"],
	[/\bBearer\s+\S+/gi, "Bearer <redacted>"],
	[
		/\b(token|secret|signature|password|credential|api[_-]?key|access[_-]?key)(\s*[=:]\s*)\S+/gi,
		"$1$2<redacted>",
	],
	[/(?<![\w.~-])\/(?:[^\s/:'"]+\/)+[^\s/:'",)]*/g, "<path>"],
];

export function redactLogText(text: string): string {
	let redacted = text;
	for (const [pattern, replacement] of REDACTIONS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted.replace(/\s+/g, " ").trim();
}

export function logReason(
	error: unknown,
	maxLength = MAX_LOG_REASON_LENGTH,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactLogText(message).slice(0, maxLength) || "unknown error";
}
