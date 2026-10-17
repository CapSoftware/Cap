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

const renderCard = () =>
	new JSDOM(renderToStaticMarkup(createElement(Platforms)));

const luminance = (rgb: string) => {
	const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string) => {
	const first = luminance(a);
	const second = luminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe("homepage platform cards", () => {
	it("keeps one visible download label across the platform cards", () => {
		const dom = renderCard();
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
		const dom = renderCard();
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

	it("keeps the Your device label readable on its tinted chip", () => {
		const dom = renderCard();
		try {
			const pill = [...dom.window.document.querySelectorAll("span")].find(
				(node) => node.textContent === "Your device",
			);
			const { color, background } = pill?.style ?? {};
			expect(color).toBeTruthy();
			expect(background).toBeTruthy();
			expect(contrast(color ?? "", background ?? "")).toBeGreaterThanOrEqual(
				4.5,
			);
		} finally {
			dom.window.close();
		}
	});
});
