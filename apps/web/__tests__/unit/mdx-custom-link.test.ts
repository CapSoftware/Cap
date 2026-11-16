import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: ReactNode }) =>
		createElement("a", { "data-internal": true, href }, children),
}));

const { CustomLink } = await import("@/components/mdx");

const render = (href: string) =>
	renderToStaticMarkup(createElement(CustomLink, { href }, "label"));

describe("docs links", () => {
	it("keeps the address of a link to another site and opens it in a new tab", () => {
		expect(render("https://github.com/video-dev/hls.js")).toBe(
			'<a href="https://github.com/video-dev/hls.js" target="_blank" rel="noopener noreferrer">label</a>',
		);
	});

	it("keeps the address of a link to a heading on the same page", () => {
		expect(render("#rate-limits")).toBe('<a href="#rate-limits">label</a>');
	});

	it("routes a site link through the app router", () => {
		expect(render("/docs/api/rest-api")).toBe(
			'<a data-internal="true" href="/docs/api/rest-api">label</a>',
		);
	});
});
