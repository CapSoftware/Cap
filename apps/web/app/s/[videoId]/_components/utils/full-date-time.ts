/**
 * The exact moment a Cap was recorded, for the tooltip on its relative time:
 * "Tuesday, 6 October 2026 at 14:32" in the viewer's locale and timezone.
 * Both default to the runtime's, so call this on the client only; the server
 * would format it in its own.
 */
export const formatFullDateTime = (
	date: Date,
	locale?: string | string[],
	timeZone?: string,
): string =>
	new Intl.DateTimeFormat(locale, {
		dateStyle: "full",
		timeStyle: "short",
		timeZone,
	}).format(date);
