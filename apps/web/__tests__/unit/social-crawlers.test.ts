import { describe, expect, it } from "vitest";
import {
	isIframelyCrawlerUserAgent,
	isSocialCrawlerUserAgent,
} from "@/lib/social-crawlers";

describe("social crawler detection", () => {
	it.each([
		"Iframely/1.3.1 (+https://iframely.com/docs/about)",
		"Iframely/2.0.0 (+https://iframely.com/docs/about) Notion",
	])("recognizes Iframely user agent %s", (userAgent) => {
		expect(isSocialCrawlerUserAgent(userAgent)).toBe(true);
		expect(isIframelyCrawlerUserAgent(userAgent)).toBe(true);
	});

	it("does not treat a normal browser as a crawler", () => {
		const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

		expect(isSocialCrawlerUserAgent(userAgent)).toBe(false);
		expect(isIframelyCrawlerUserAgent(userAgent)).toBe(false);
	});
});
