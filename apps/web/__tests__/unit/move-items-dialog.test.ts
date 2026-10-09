// @vitest-environment jsdom

import { Folder, Organisation, Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	destinations: vi.fn(),
	folders: vi.fn(),
	place: vi.fn(),
	move: vi.fn(),
	moveFolder: vi.fn(),
	refresh: vi.fn(),
	close: vi.fn(),
}));
vi.mock("@/actions/folders/move-items", () => ({
	getOwnedVideoMoveDestinations: mocks.destinations,
	getMoveFolderDestinations: mocks.folders,
	placeOwnedVideos: mocks.place,
	moveVideos: mocks.move,
	moveFolder: mocks.moveFolder,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "owner", activeOrganizationId: "org" }),
}));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/LoadingSpinner")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));

import { MoveItemsDialog } from "@/app/(org)/dashboard/caps/components/MoveItemsDialog";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const videoId = Video.VideoId.make("video");
const folderId = Folder.FolderId.make("team-folder");

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.destinations.mockResolvedValue([
		{ name: "My Caps", location: { type: "personal" }, folders: [] },
		{
			name: "All team members",
			location: { type: "organization" },
			folders: [{ id: folderId, name: "Team folder", parentId: null }],
		},
	]);
	mocks.folders.mockResolvedValue([]);
	mocks.place.mockResolvedValue({ moved: 1 });
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
async function render(
	item: React.ComponentProps<typeof MoveItemsDialog>["item"] = {
		type: "videos",
		videoIds: [videoId],
		currentFolderId: null,
	},
	organizationId?: Organisation.OrganisationId,
) {
	await act(async () => {
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(MoveItemsDialog, {
					open: true,
					onOpenChange: mocks.close,
					location: { type: "personal" },
					rootLabel: "My Caps",
					organizationId,
					item,
				}),
			),
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}
function button(label: string) {
	const element = [...document.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label,
	);
	if (!element) throw new Error(`Button not found: ${label}`);
	return element;
}
async function chooseTeam() {
	const select = document.querySelector("select");
	if (!select) throw new Error("Location selector not found");
	await act(async () => {
		select.value = "organization";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("moving Caps from My Caps to a team location", () => {
	it("shows the team folder and explains sharing before submitting its destination", async () => {
		await render();
		expect(button("Move").disabled).toBe(true);
		await chooseTeam();
		expect(document.body.textContent).toContain(
			"People with access to All team members",
		);
		await act(async () => button("Team folder").click());
		await act(async () => button("Share & move").click());
		expect(mocks.place).toHaveBeenCalledWith({
			videoIds: [videoId],
			folderId,
			location: { type: "organization" },
		});
		expect(mocks.move).not.toHaveBeenCalled();
	});

	it("allows the team root even when the Cap starts at the personal root", async () => {
		await render();
		await chooseTeam();
		expect(button("Share & move").disabled).toBe(false);
		await act(async () => button("Share & move").click());
		expect(mocks.place).toHaveBeenCalledWith({
			videoIds: [videoId],
			folderId: null,
			location: { type: "organization" },
		});
	});

	it("uses the Cap's organization when it differs from the active one", async () => {
		const organizationId = Organisation.OrganisationId.make("cap-org");
		await render(undefined, organizationId);
		expect(mocks.destinations).toHaveBeenCalledWith(organizationId);
		await chooseTeam();
		await act(async () => button("Share & move").click());
		expect(mocks.place).toHaveBeenCalledWith({
			videoIds: [videoId],
			folderId: null,
			location: { type: "organization" },
			organizationId,
		});
	});

	it("keeps folder moves within their original location", async () => {
		await render({ type: "folder", folderId, currentParentId: null });
		expect(document.querySelector("select")).toBeNull();
		expect(mocks.destinations).not.toHaveBeenCalled();
		expect(mocks.folders).toHaveBeenCalledWith({ type: "personal" });
	});
});
