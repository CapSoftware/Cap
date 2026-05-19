import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
	it("renders default button attributes and content", () => {
		const markup = renderToStaticMarkup(<Button>Record</Button>);

		expect(markup).toContain("<button");
		expect(markup).toContain("Record");
		expect(markup).toContain("bg-gray-12");
		expect(markup).toContain("h-[44px]");
	});

	it("renders links, keyboard hints, and loading state", () => {
		const markup = renderToStaticMarkup(
			<Button href="/download" spinner kbd="D" variant="blue" target="_blank">
				Download
			</Button>,
		);

		expect(markup).toContain("<a");
		expect(markup).toContain('href="/download"');
		expect(markup).toContain('target="_blank"');
		expect(markup).toContain("Download");
		expect(markup).toContain("<kbd");
		expect(markup).toContain(">D</kbd>");
		expect(markup).toContain("animation:spin");
		expect(markup).toContain("bg-blue-600");
	});
});
