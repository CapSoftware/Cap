// @vitest-environment jsdom

import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Children = { children?: React.ReactNode };

vi.mock("@cap/ui", () => ({
	DropdownMenu: ({ children }: Children) =>
		React.createElement("div", null, children),
	DropdownMenuTrigger: ({ children }: Children) =>
		React.createElement("div", null, children),
	DropdownMenuContent: ({ children }: Children) =>
		React.createElement("div", { role: "menu" }, children),
	DropdownMenuItem: ({ children }: Children) =>
		React.createElement("div", { role: "menuitem" }, children),
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));

import { FoldersDropdown } from "@/app/(org)/dashboard/caps/components/FoldersDropdown";

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
});

const baseProps = {
	id: "folder-1",
	setIsRenaming: () => {},
	setConfirmDeleteFolderOpen: () => {},
	nameRef: createRef<HTMLTextAreaElement>(),
	onPublicToggle: () => {},
	onCopyPublicLink: () => {},
	onMove: () => {},
};

const renderMenu = async (props: {
	canEdit: boolean;
	canMove: boolean;
	public: boolean;
}) => {
	await act(async () =>
		root.render(
			React.createElement(FoldersDropdown, { ...baseProps, ...props }),
		),
	);
	return {
		trigger: container.querySelector("button"),
		items: [...container.querySelectorAll('[role="menuitem"]')].map((item) =>
			item.textContent?.trim(),
		),
	};
};

describe("folder card menu", () => {
	it("offers every action to someone who can edit the folder", async () => {
		const { items } = await renderMenu({
			canEdit: true,
			canMove: true,
			public: true,
		});

		expect(items).toEqual([
			"Rename",
			"Make private",
			"Copy public link",
			"Move",
			"Delete",
		]);
	});

	it("only offers the public link to a member who cannot edit a public folder", async () => {
		const { items } = await renderMenu({
			canEdit: false,
			canMove: false,
			public: true,
		});

		expect(items).toEqual(["Copy public link"]);
	});

	it("shows no menu to a member who cannot edit a private folder", async () => {
		const { trigger, items } = await renderMenu({
			canEdit: false,
			canMove: false,
			public: false,
		});

		expect(trigger).toBeNull();
		expect(items).toEqual([]);
	});
});
