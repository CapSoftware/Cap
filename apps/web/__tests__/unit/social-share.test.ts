import { describe, expect, it } from "vitest";
import {
	shareTargetHref,
	shareUrlWithTimestamp,
	socialShareUrl,
} from "@/lib/social-share";

const URL_UNDER_TEST = "https://cap.so/s/abc123";

/**
 * These assert the exact third-party contracts. A share intent with a wrong
 * parameter name doesn't error — it opens an empty composer — so nothing else
 * in the stack catches a typo here.
 */
describe("shareTargetHref", () => {
	it("points LinkedIn at share-offsite with the encoded url", () => {
		expect(
			shareTargetHref({
				target: "linkedin",
				url: URL_UNDER_TEST,
				title: "My Cap",
			}),
		).toBe(
			"https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fcap.so%2Fs%2Fabc123",
		);
	});

	it("posts to X with both url and text", () => {
		expect(
			shareTargetHref({ target: "x", url: URL_UNDER_TEST, title: "My Cap" }),
		).toBe(
			"https://x.com/intent/post?url=https%3A%2F%2Fcap.so%2Fs%2Fabc123&text=My%20Cap",
		);
	});

	it("uses the Facebook sharer `u` parameter", () => {
		expect(
			shareTargetHref({
				target: "facebook",
				url: URL_UNDER_TEST,
				title: "My Cap",
			}),
		).toBe(
			"https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fcap.so%2Fs%2Fabc123",
		);
	});

	it("opens a Gmail compose window with the link in the body", () => {
		const href = shareTargetHref({
			target: "gmail",
			url: URL_UNDER_TEST,
			title: "My Cap",
		});
		expect(href.startsWith("https://mail.google.com/mail/?view=cm&fs=1&")).toBe(
			true,
		);
		expect(href).toContain("su=My%20Cap");
		// Gmail only unfurls a preview when the URL is in the body.
		expect(href).toContain(encodeURIComponent(URL_UNDER_TEST));
	});

	it("escapes titles that would otherwise break the query string", () => {
		const href = shareTargetHref({
			target: "x",
			url: URL_UNDER_TEST,
			title: "Q3 review & retro?",
		});
		expect(href).toContain("text=Q3%20review%20%26%20retro%3F");
	});
});

describe("shareUrlWithTimestamp", () => {
	it("adds `t` in seconds", () => {
		expect(shareUrlWithTimestamp(URL_UNDER_TEST, 83)).toBe(
			"https://cap.so/s/abc123?t=83",
		);
	});

	it("floors fractional positions", () => {
		expect(shareUrlWithTimestamp(URL_UNDER_TEST, 83.94)).toBe(
			"https://cap.so/s/abc123?t=83",
		);
	});

	it("keeps existing query params and replaces an existing `t`", () => {
		expect(
			shareUrlWithTimestamp("https://cap.so/s/abc123?t=5&autoplay=true", 42),
		).toBe("https://cap.so/s/abc123?t=42&autoplay=true");
	});

	it("clamps negative and non-finite positions to zero", () => {
		expect(shareUrlWithTimestamp(URL_UNDER_TEST, -12)).toBe(
			"https://cap.so/s/abc123?t=0",
		);
		expect(shareUrlWithTimestamp(URL_UNDER_TEST, Number.NaN)).toBe(
			"https://cap.so/s/abc123?t=0",
		);
	});
});

describe("socialShareUrl", () => {
	it("leaves the url alone without a timestamp", () => {
		expect(socialShareUrl({ url: URL_UNDER_TEST })).toBe(URL_UNDER_TEST);
	});

	it("rewrites cap.link short links to their crawlable canonical form", () => {
		expect(socialShareUrl({ url: "https://cap.link/abc123" })).toBe(
			"https://cap.so/s/abc123",
		);
	});

	it("applies the timestamp after canonicalising", () => {
		expect(
			socialShareUrl({ url: "https://cap.link/abc123", timestamp: 7 }),
		).toBe("https://cap.so/s/abc123?t=7");
	});

	it("preserves custom domains", () => {
		expect(
			socialShareUrl({ url: "https://videos.acme.com/s/abc123", timestamp: 9 }),
		).toBe("https://videos.acme.com/s/abc123?t=9");
	});
});
