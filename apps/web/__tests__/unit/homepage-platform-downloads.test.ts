import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Platforms } from "@/components/pages/HomeTwo/Platforms";

const DOWNLOADS = [
	{ href: "/download/apple-silicon", name: "macOS" },
	{ href: "/download/windows", name: "Windows" },
	{ href: "/download/linux-deb", name: "Linux" },
];

describe("homepage platform downloads", () => {
	it("keeps one visible download label across the platform cards", () => {
		const dom = new JSDOM(renderToStaticMarkup(createElement(Platforms)));
		try {
			const labels = DOWNLOADS.map(
				({ href }) =>
					dom.window.document.querySelector(`a[href="${href}"]`)?.textContent,
			);
			expect(labels).toEqual(["Download now", "Download now", "Download now"]);
		} finally {
			dom.window.close();
		}
	});

	it("names each download link after the platform it installs", () => {
		const dom = new JSDOM(renderToStaticMarkup(createElement(Platforms)));
		try {
			const document = dom.window.document;
			for (const { href, name } of DOWNLOADS) {
				const link = document.querySelector(`a[href="${href}"]`);
				expect(link, href).not.toBeNull();
				expect(
					link?.getAttribute("aria-label") ?? link?.textContent?.trim(),
					href,
				).toBe(`Download Cap for ${name}`);
			}
		} finally {
			dom.window.close();
		}
	});
});
