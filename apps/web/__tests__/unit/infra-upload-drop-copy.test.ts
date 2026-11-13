// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(infra)/dashboard/infra/_components/uploads", () => ({
	useUploads: () => ({
		appId: "app-1",
		active: null,
		waiting: 0,
		failures: [],
		add: vi.fn(),
		cancel: vi.fn(),
	}),
}));

import { UploadDrop } from "@/app/(infra)/dashboard/infra/_components/upload-drop";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("UploadDrop copy", () => {
	it("says encoding is free and that uploading needs a balance", () => {
		act(() => root.render(React.createElement(UploadDrop)));
		const text = (container.textContent ?? "").replace(/\s+/g, " ");

		expect(text).toContain(
			"Encoding is free. Stored video is billed by the minute, and uploading needs a balance that covers its first month.",
		);
		expect(text).not.toMatch(/uploads are free/i);
	});
});
