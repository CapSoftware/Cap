import { describe, expect, it } from "vitest";
import {
	MASK_COLOR,
	maskClone,
	maskedElements,
	pageBackground,
	paintMasks,
	shouldMask,
} from "../src/screenshot";

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

describe("painting masks over the drawn screenshot", () => {
	it("covers every masked element's box, including canvas and iframes", () => {
		document.body.innerHTML = `
			<canvas data-worm-mask id="signature"></canvas>
			<iframe data-worm-mask id="viewer"></iframe>
			<input id="name">
			<div id="widget"><input id="inside-widget"></div>
			<input id="hidden-away">`;
		const box = (id: string, rect: Partial<DOMRect>) => {
			const element = document.getElementById(id);
			if (element)
				element.getBoundingClientRect = () =>
					({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect;
		};
		box("signature", { left: 10, top: 20, width: 100, height: 40 });
		box("viewer", { left: 0, top: 100, width: 300, height: 200 });
		box("name", { left: 5, top: 5, width: 50, height: 10 });
		box("inside-widget", { left: 1, top: 1, width: 10, height: 10 });
		const rects: number[][] = [];
		const context = {
			fillStyle: "",
			fillRect: (...args: number[]) => rects.push(args),
		};
		const painted = paintMasks(
			context,
			maskedElements(),
			2,
			document.getElementById("widget"),
		);
		expect(painted).toBe(3);
		expect(context.fillStyle).toBe(MASK_COLOR);
		expect(rects).toContainEqual([20, 40, 201, 81]);
		expect(rects).toContainEqual([0, 200, 601, 401]);
	});

	it("finds masked elements inside open shadow roots", () => {
		document.body.innerHTML = "<div id='host'></div>";
		const shadow = document
			.getElementById("host")
			?.attachShadow({ mode: "open" });
		if (shadow) shadow.innerHTML = "<p data-worm-mask>Jane</p><input>";
		expect(maskedElements()).toHaveLength(2);
	});

	it("uses a real page colour for the background", () => {
		document.body.style.background = "";
		document.documentElement.style.background = "rgb(1, 2, 3)";
		expect(pageBackground()).toBe("rgb(1, 2, 3)");
		document.documentElement.style.background = "";
		expect(pageBackground()).toBe("#ffffff");
	});
});

describe("the widget itself", () => {
	it("is never searched for masks, so its own fields leave no box", () => {
		document.body.innerHTML = "<input id='page'><div id='widget'></div>";
		const widget = document.getElementById("widget");
		const shadow = widget?.attachShadow({ mode: "open" });
		if (shadow) shadow.innerHTML = "<textarea></textarea>";
		const found = maskedElements(document, widget);
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe("page");
	});
});
