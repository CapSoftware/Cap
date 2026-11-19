// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(infra)/dashboard/infra/_components/uploads", () => ({
	useUploads: () => ({
		appId: "app-1",
		active: null,
		waiting: 0,
		failures: [
			{
				id: "failure-1",
				name: "lesson.mp4",
				message: "This app has no credit. Add credits to start uploading.",
				needsCredits: true,
				skipped: 0,
			},
		],
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

const creditLinks = () =>
	Array.from(container.querySelectorAll("a")).filter(
		(link) => link.textContent === "Add credits",
	);

describe("UploadDrop credit link", () => {
	it("links to Billing from a refused upload by default", () => {
		act(() => root.render(React.createElement(UploadDrop)));

		expect(creditLinks()).toHaveLength(1);
		expect(creditLinks()[0]?.getAttribute("href")).toBe(
			"/dashboard/infra/app-1/billing",
		);
	});

	it("leaves the link out when the page already shows an Add credits button", () => {
		act(() =>
			root.render(React.createElement(UploadDrop, { creditsLink: false })),
		);

		expect(creditLinks()).toHaveLength(0);
		expect(container.textContent).toContain(
			"This app has no credit. Add credits to start uploading.",
		);
	});
});
