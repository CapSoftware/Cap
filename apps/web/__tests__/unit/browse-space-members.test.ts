// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewSpaceFormProps } from "@/app/(org)/dashboard/_components/Navbar/SpaceDialog";
import BrowseSpacesPage from "@/app/(org)/dashboard/spaces/browse/page";

const mocks = vi.hoisted(() => ({
	getSpaceMemberIds: vi.fn(),
	error: vi.fn(),
	dialog: vi.fn(),
}));

vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: "creator" },
		activeOrganization: {
			members: ["creator", "member", "non-member"].map((id) => ({
				user: { id },
			})),
		},
		spacesData: [
			{
				id: "space-1",
				name: "Private project",
				primary: false,
				currentUserCanManage: true,
				currentUserRole: "admin",
				memberCount: 2,
				videoCount: 1,
			},
		],
	}),
}));
vi.mock("@/app/(org)/dashboard/spaces/[spaceId]/actions", () => ({
	getSpaceMemberIds: mocks.getSpaceMemberIds,
}));
vi.mock("@/actions/organization/delete-space", () => ({
	deleteSpace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({}),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: mocks.error },
}));
vi.mock("@cap/ui", () => ({
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) =>
		createElement("button", { type: "button", onClick, disabled }, children),
	Input: () => null,
}));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/SpaceDialog", () => ({
	default: (props: { open: boolean; space: NewSpaceFormProps["space"] }) => {
		mocks.dialog(props);
		return props.open ? createElement("div", { role: "dialog" }) : null;
	},
}));

let root: Root;
let host: HTMLDivElement;

async function editSpace() {
	const edit = host.querySelector("tbody button");
	if (!(edit instanceof HTMLButtonElement)) throw new Error("No edit button");
	await act(async () => edit.click());
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.getSpaceMemberIds.mockReset().mockResolvedValue(["creator", "member"]);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(createElement(BrowseSpacesPage)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("editing a space from Browse Spaces", () => {
	it("selects the actual space members without adding other organization members", async () => {
		await editSpace();

		expect(mocks.dialog).toHaveBeenLastCalledWith(
			expect.objectContaining({
				open: true,
				space: expect.objectContaining({
					id: "space-1",
					members: ["creator", "member"],
				}),
			}),
		);
		expect(mocks.getSpaceMemberIds).toHaveBeenCalledWith("space-1");
	});

	it("waits for membership before opening the editor", async () => {
		let finish!: (ids: string[]) => void;
		mocks.getSpaceMemberIds.mockReturnValue(
			new Promise<string[]>((resolve) => {
				finish = resolve;
			}),
		);
		await editSpace();

		expect(host.querySelector("[role=dialog]")).toBeNull();
		expect(host.querySelector("tbody button")?.hasAttribute("disabled")).toBe(
			true,
		);
		await act(async () => finish(["creator"]));
		expect(mocks.dialog).toHaveBeenLastCalledWith(
			expect.objectContaining({
				open: true,
				space: expect.objectContaining({ members: ["creator"] }),
			}),
		);
	});

	it("leaves the dialog closed on a lookup error and allows retrying", async () => {
		mocks.getSpaceMemberIds.mockRejectedValueOnce(new Error("Unavailable"));
		await editSpace();

		expect(host.querySelector("[role=dialog]")).toBeNull();
		expect(mocks.error).toHaveBeenCalledWith("Failed to load space members");
		expect(host.querySelector("tbody button")?.hasAttribute("disabled")).toBe(
			false,
		);
		await editSpace();
		expect(host.querySelector("[role=dialog]")).not.toBeNull();
	});
});
