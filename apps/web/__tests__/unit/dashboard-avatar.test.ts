// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "@/app/(org)/dashboard/_components/Avatar";

describe("dashboard avatar initial", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	const renderInitial = async (name: string | null) => {
		await act(async () => root.render(createElement(Avatar, { name })));
		return container.querySelector("span")?.textContent;
	};

	it("shows the whole emoji for names starting with an emoji", async () => {
		expect(await renderInitial("\u{1F600} Team")).toBe("\u{1F600}");
	});

	it("ignores leading whitespace", async () => {
		expect(await renderInitial("  bob")).toBe("B");
	});

	it("falls back to A for empty or missing names", async () => {
		expect(await renderInitial("")).toBe("A");
		expect(await renderInitial(null)).toBe("A");
	});
});
