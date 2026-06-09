import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LinkifiedText } from "@/components/LinkifiedText";

vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
	},
}));

vi.stubGlobal("React", React);

const renderLinkifiedText = (text: string) =>
	renderToStaticMarkup(React.createElement(LinkifiedText, { text }));

describe("LinkifiedText", () => {
	it("does not link unsafe protocols", () => {
		const html = renderLinkifiedText(
			"javascript:alert(1) data:text/html,hello www.javascript:alert(1)",
		);

		expect(html).not.toContain("<a");
		expect(html).not.toContain("href=");
		expect(html).toContain("javascript:alert(1)");
	});

	it("does not link plain http urls", () => {
		const html = renderLinkifiedText("http://cap.so/s/demo");

		expect(html).not.toContain("<a");
		expect(html).not.toContain("<button");
		expect(html).toContain("http://cap.so/s/demo");
	});

	it("normalizes www urls to https", () => {
		const html = renderLinkifiedText("www.cap.so/s/demo");

		expect(html).toContain('href="https://www.cap.so/s/demo"');
		expect(html).toContain("www.cap.so/s/demo");
	});

	it("does not trust host-confusion urls", () => {
		const html = renderLinkifiedText("https://cap.so@evil.test/path");

		expect(html).not.toContain("<a");
		expect(html).not.toContain("<button");
		expect(html).not.toContain('href="https://cap.so@evil.test/path"');
		expect(html).toContain("https://cap.so@evil.test/path");
	});

	it("renders ordinary external urls as warning buttons without trigger hrefs", () => {
		const html = renderLinkifiedText("https://evil.test/path");

		expect(html).toContain("<button");
		expect(html).not.toContain('href="https://evil.test/path"');
		expect(html).toContain("https://evil.test/path");
	});

	it("renders trusted Cap links directly with opener and referrer protections", () => {
		const html = renderLinkifiedText("Visit https://cap.so/s/demo");

		expect(html).toContain('href="https://cap.so/s/demo"');
		expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
		expect(html).toContain('referrerPolicy="no-referrer"');
	});

	it("does not link credential-bearing urls", () => {
		const html = renderLinkifiedText("https://user:pass@cap.so/s/demo");

		expect(html).not.toContain("<a");
		expect(html).not.toContain("<button");
		expect(html).toContain("https://user:pass@cap.so/s/demo");
	});

	it("escapes non-link markup in comment text", () => {
		const html = renderLinkifiedText(
			"<img src=x onerror=alert(1)> https://cap.so/s/demo",
		);

		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img");
	});
});
