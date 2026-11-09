import { describe, expect, it } from "vitest";
import { maskClone, shouldMask } from "../src/screenshot";

const clone = (html: string) => {
	const wrap = document.createElement("div");
	wrap.innerHTML = html;
	return wrap.firstElementChild as HTMLElement;
};

describe("screenshot masking", () => {
	it("masks every kind of field and marked region", () => {
		for (const html of [
			'<input value="Jane">',
			'<input type="password" value="x">',
			'<input type="checkbox" checked>',
			"<textarea>notes</textarea>",
			"<select><option selected>HIV+</option></select>",
			'<div contenteditable="true">draft</div>',
			"<section data-worm-mask><p>Jane Doe</p></section>",
			'<img data-worm-mask src="/scan.png" alt="scan of Jane">',
		])
			expect(shouldMask(clone(html)), html).toBe(true);
	});

	it("leaves buttons, hidden inputs and plain content alone", () => {
		for (const html of [
			'<input type="submit" value="Save">',
			'<input type="hidden" value="csrf">',
			"<p>Welcome</p>",
			'<div contenteditable="false">static</div>',
		])
			expect(shouldMask(clone(html)), html).toBe(false);
	});

	it("removes values, text, children and images from the clone", () => {
		const input = clone(
			'<input value="Jane Doe" placeholder="Name">',
		) as HTMLInputElement;
		input.value = "Jane Doe";
		maskClone(input);
		expect(input.value).toBe("");
		expect(input.outerHTML).not.toContain("Jane");
		expect(input.hasAttribute("data-worm-masked")).toBe(true);

		const region = clone(
			'<section data-worm-mask class="card"><h1>Jane Doe</h1><img src="/a.png"></section>',
		);
		maskClone(region);
		expect(region.childNodes).toHaveLength(0);
		expect(region.outerHTML).not.toMatch(/Jane|a\.png|card/);
		expect(region.style.getPropertyValue("color")).toBe("transparent");

		const image = clone(
			'<img data-worm-mask src="/scan.png" srcset="/scan2.png 2x" alt="Jane">',
		) as HTMLImageElement;
		maskClone(image);
		expect(image.outerHTML).not.toMatch(/scan|Jane/);

		const area = clone(
			"<textarea>private notes</textarea>",
		) as HTMLTextAreaElement;
		maskClone(area);
		expect(area.outerHTML).not.toContain("private");

		const select = clone("<select><option selected>HIV+</option></select>");
		maskClone(select);
		expect(select.outerHTML).not.toContain("HIV");
	});

	it("does nothing to content that is not masked", () => {
		const paragraph = clone("<p>Hello</p>");
		maskClone(paragraph);
		expect(paragraph.outerHTML).toBe("<p>Hello</p>");
	});
});
