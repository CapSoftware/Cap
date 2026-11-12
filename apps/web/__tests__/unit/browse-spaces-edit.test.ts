// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	memberIds: vi.fn(),
	dialog: {
		open: false,
		space: null as { name: string; members: string[] } | null,
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	useParams: () => ({}),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@cap/ui", () => ({
	Button: ({
		children,
		onClick,
	}: {
		children: React.ReactNode;
		onClick?: (e: unknown) => void;
	}) => React.createElement("button", { type: "button", onClick }, children),
	Input: () => null,
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/actions/organization/delete-space", () => ({
	deleteSpace: vi.fn(),
}));
vi.mock("@/actions/organization/get-space-member-ids", () => ({
	getSpaceMemberIds: mocks.memberIds,
}));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/SpaceDialog", () => ({
	default: (props: {
		open: boolean;
		space: { name: string; members: string[] } | null;
	}) => {
		mocks.dialog = { open: props.open, space: props.space };
		return null;
	},
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		spacesData: [
			{
				id: "space-1",
				name: "Private space",
				iconUrl: null,
				memberCount: 1,
				videoCount: 0,
				currentUserRole: "admin",
				currentUserCanManage: true,
				primary: false,
				settings: null,
				hasPassword: false,
				public: false,
			},
		],
		user: { id: "owner" },
		activeOrganization: {
			members: [
				{ user: { id: "owner" } },
				{ user: { id: "bob" } },
				{ user: { id: "cara" } },
			],
		},
	}),
}));

import BrowseSpacesPage from "@/app/(org)/dashboard/spaces/browse/page";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.memberIds.mockReset();
	mocks.dialog = { open: false, space: null };
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(React.createElement(BrowseSpacesPage)));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const editButton = () => {
	const row = [...container.querySelectorAll("tr")].find((tr) =>
		tr.textContent?.includes("Private space"),
	);
	const button = row?.querySelector("td:last-child button");
	if (!button) throw new Error("Edit button missing");
	return button as HTMLButtonElement;
};
const createButton = () => {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === "Create Space",
	);
	if (!button) throw new Error("Create Space button missing");
	return button;
};

describe("editing a space from Browse Spaces", () => {
	it("starts the form from the space's own members", async () => {
		mocks.memberIds.mockResolvedValue(["owner"]);
		await act(async () => editButton().click());

		expect(mocks.memberIds).toHaveBeenCalledWith("space-1");
		expect(mocks.dialog.open).toBe(true);
		expect(mocks.dialog.space?.members).toEqual(["owner"]);
	});

	it("does not open the form when the members cannot be loaded", async () => {
		mocks.memberIds.mockResolvedValue(null);
		await act(async () => editButton().click());

		expect(mocks.dialog.open).toBe(false);
	});

	it("leaves a Create form alone when an earlier lookup finishes", async () => {
		let finish = (_ids: string[]) => {};
		mocks.memberIds.mockReturnValue(
			new Promise<string[]>((resolve) => {
				finish = resolve;
			}),
		);
		await act(async () => editButton().click());
		await act(async () => createButton().click());
		await act(async () => finish(["owner"]));

		expect(mocks.dialog.open).toBe(true);
		expect(mocks.dialog.space).toBeNull();
	});
});
