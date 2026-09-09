// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function queryByRole(
	container: ParentNode,
	role: string,
	options?: { name: string; exact?: boolean },
) {
	const selector = role === "button" ? "button" : `[role="${role}"]`;
	return (
		Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
			(element) => {
				if (!options?.name) return true;
				const label = element.id
					? document.querySelector(`label[for="${element.id}"]`)?.textContent
					: null;
				return (
					label === options.name || element.textContent?.trim() === options.name
				);
			},
		) ?? null
	);
}
function getByRole(
	container: ParentNode,
	role: string,
	options?: { name: string; exact?: boolean },
) {
	const element = queryByRole(container, role, options);
	if (!element) throw new Error(`Missing ${role}: ${options?.name ?? ""}`);
	return element;
}
async function waitFor(assertion: () => void) {
	let error: unknown;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			assertion();
			return;
		} catch (cause) {
			error = cause;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw error;
}
const fireEvent = {
	click: (element: HTMLElement) => element.click(),
	keyDown: (element: HTMLElement, init: KeyboardEventInit) =>
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, ...init }),
		),
	change: (
		element: HTMLInputElement,
		{ target }: { target: { value: string } },
	) => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (!setter) throw new Error("Missing input setter");
		setter.call(element, target.value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	},
};
const mocks = vi.hoisted(() => ({
	folders: vi.fn(),
	import: vi.fn(),
	push: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: "owner", isPro: true },
		activeOrganization: {
			organization: { id: "org", name: "Team", ownerId: "owner" },
			members: [],
		},
		spacesData: [{ id: "space", name: "Sales" }],
	}),
}));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("next/link", () => ({
	default: ({
		children,
		...props
	}: React.PropsWithChildren<Record<string, unknown>>) =>
		React.createElement("a", props, children),
}));
vi.mock("@/actions/loom", () => ({
	getLoomImportFolders: mocks.folders,
	importFromLoom: mocks.import,
	importFromLoomCsv: vi.fn(),
}));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/Select")),
	...(await import("../../../../packages/ui/src/components/Table")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));

import { Folder, Space } from "@cap/web-domain";
import { ImportLoomPage } from "@/app/(org)/dashboard/import/loom/ImportLoomPage";
import type { LoomImportDestination } from "@/lib/loom-import-destination";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	HTMLElement.prototype.scrollIntoView = vi.fn();
	HTMLElement.prototype.hasPointerCapture = () => false;
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.releasePointerCapture = vi.fn();
	mocks.folders.mockResolvedValue([
		{ id: "parent", name: "Course", parentId: null },
		{ id: "child", name: "Live Calls - Two", parentId: "parent" },
		{ id: "sibling", name: "Design", parentId: "parent" },
	]);
	mocks.import.mockResolvedValue({ success: true, videoId: "fixture" });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
});
async function render(destination: LoomImportDestination = {}) {
	await act(async () => {
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(ImportLoomPage, {
					initialDestination: destination,
				}),
			),
		);
	});
}
async function ready() {
	await waitFor(() =>
		expect(
			(getByRole(container, "combobox") as HTMLButtonElement).disabled,
		).toBe(false),
	);
}
async function enterUrl() {
	await act(async () => {
		const input = container.querySelector("input");
		if (!input) throw new Error("Missing Loom URL input");
		fireEvent.change(input, {
			target: { value: "https://www.loom.com/share/aaaaaaaaaaa" },
		});
	});
}
async function choose(name: string) {
	await act(async () => {
		fireEvent.keyDown(getByRole(container, "combobox"), { key: "Enter" });
	});
	await act(async () => {
		fireEvent.keyDown(
			getByRole(document.body, "option", { name, exact: true }),
			{ key: "Enter" },
		);
	});
}

describe("Loom importer component", () => {
	it("shows the inherited subfolder and submits it then returns there", async () => {
		await render({ folderId: Folder.FolderId.make("child") });
		await ready();
		expect(
			getByRole(container, "combobox", { name: "Import to" }).textContent,
		).toContain("My Caps / Course / Live Calls - Two");
		await enterUrl();
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith({
			loomUrl: "https://www.loom.com/share/aaaaaaaaaaa",
			orgId: "org",
			folderId: "child",
			spaceId: undefined,
		});
		expect(mocks.push).toHaveBeenCalledWith("/dashboard/folder/child");
	});
	it("allows choosing a different nested folder", async () => {
		await render({ folderId: Folder.FolderId.make("child") });
		await ready();
		await choose("My Caps / Course / Design");
		await enterUrl();
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({ folderId: "sibling" }),
		);
	});
	it("blocks a missing folder until the user chooses a destination", async () => {
		await render({ folderId: Folder.FolderId.make("missing") });
		await ready();
		await enterUrl();
		expect(getByRole(container, "alert").textContent).toContain(
			"no longer available",
		);
		expect(
			(
				getByRole(container, "button", {
					name: "Import Loom",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await choose("My Caps");
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({ folderId: undefined }),
		);
	});
	it("shows a recoverable destination error without enabling import", async () => {
		mocks.folders.mockRejectedValueOnce(new Error("Unavailable"));
		await render();
		await enterUrl();
		await waitFor(() =>
			expect(getByRole(container, "alert").textContent).toContain(
				"couldn't load",
			),
		);
		expect(
			(
				getByRole(container, "button", {
					name: "Import Loom",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Retry" }));
		});
		await ready();
		expect(queryByRole(container, "alert")).toBe(null);
	});
	it("shows shared visibility and returns to the selected space folder", async () => {
		await render({
			spaceId: Space.SpaceId.make("space"),
			folderId: Folder.FolderId.make("child"),
		});
		await ready();
		await enterUrl();
		expect(container.textContent).toContain(
			"This video will be shared with Sales.",
		);
		await act(async () => {
			fireEvent.click(getByRole(container, "button", { name: "Import Loom" }));
		});
		expect(mocks.import).toHaveBeenCalledWith(
			expect.objectContaining({
				spaceId: Space.SpaceId.make("space"),
				folderId: Folder.FolderId.make("child"),
			}),
		);
		expect(mocks.push).toHaveBeenCalledWith(
			"/dashboard/spaces/space/folder/child",
		);
	});
});
