import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopDemo } from "@/components/pages/HomeTwo/demo/DesktopDemo";

describe("homepage demo keyboard controls", () => {
	it("keeps hidden controls inert until the visitor starts the tour", () => {
		const dom = new JSDOM(renderToStaticMarkup(createElement(DesktopDemo)));
		try {
			const buttons = [...dom.window.document.querySelectorAll("button")];
			for (const label of [
				"Jump to Instant Mode",
				"Jump to Studio Mode",
				"Jump to The Editor",
				"Skip demo",
				"Restart demo",
				"Start recording",
				"Stop recording",
				"Export the recording",
			]) {
				const button = buttons.find(
					(candidate) =>
						(candidate.getAttribute("aria-label") ??
							candidate.textContent?.trim()) === label,
				);
				expect(button, label).toBeDefined();
				expect(button?.closest("[inert]"), label).not.toBeNull();
			}
		} finally {
			dom.window.close();
		}
	});
});
