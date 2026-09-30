/**
 * Share-target URL builders for the video share dialog.
 *
 * Deliberately React-free so the shapes can be unit tested. Every one of these
 * is a third-party contract that fails *silently* in the UI — a mistyped
 * parameter name doesn't throw, it just opens an empty composer on the other
 * end — so the tests are the only thing standing between a typo and a broken
 * share button.
 */

import { canonicalVideoShareUrl } from "./video-share-clipboard";

export type ShareTargetId = "linkedin" | "x" | "facebook" | "gmail";

/**
 * Adds (or replaces) the `?t=` start offset the share page reads on load.
 * Seconds are floored to an integer because that's what `Share.tsx` parses.
 */
export const shareUrlWithTimestamp = (url: string, seconds: number): string => {
	const start =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	try {
		const parsed = new URL(url);
		parsed.searchParams.set("t", String(start));
		return parsed.toString();
	} catch {
		// Not absolute (shouldn't happen for share links, but never break copy).
		const separator = url.includes("?") ? "&" : "?";
		return `${url}${separator}t=${start}`;
	}
};

/**
 * The URL handed to third parties. `cap.link` short links are rewritten to
 * their `cap.so` canonical form: the crawlers behind these previews follow
 * redirects inconsistently, and an unfurl that resolves to nothing is worse
 * than a longer URL.
 */
export const socialShareUrl = ({
	url,
	timestamp,
}: {
	url: string;
	timestamp?: number | null;
}): string => {
	const canonical = canonicalVideoShareUrl(url);
	return typeof timestamp === "number"
		? shareUrlWithTimestamp(canonical, timestamp)
		: canonical;
};

export const shareTargetHref = ({
	target,
	url,
	title,
}: {
	target: ShareTargetId;
	url: string;
	title: string;
}): string => {
	const link = encodeURIComponent(url);

	switch (target) {
		case "linkedin":
			// share-offsite takes the URL only — LinkedIn dropped support for
			// prefilled text years ago and silently ignores any `title`/`summary`.
			return `https://www.linkedin.com/sharing/share-offsite/?url=${link}`;
		case "x":
			return `https://x.com/intent/post?url=${link}&text=${encodeURIComponent(title)}`;
		case "facebook":
			return `https://www.facebook.com/sharer/sharer.php?u=${link}`;
		case "gmail":
			// `view=cm&fs=1` is Gmail's compose deep link. Sending the URL in the
			// body (rather than only the subject) is what makes Gmail unfurl it
			// into a preview card.
			return `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(
				title,
			)}&body=${encodeURIComponent(`${title}\n\n${url}`)}`;
	}
};
