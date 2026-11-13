// @vitest-environment jsdom

import { Folder, Organisation, Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Option } from "effect";
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
	create: vi.fn(),
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
vi.mock("@/app/(org)/dashboard/DashboardContext", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { id: "org" } },
	}),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "owner", activeOrganizationId: "org" }),
}));
vi.mock("@/lib/EffectRuntime", async () => {
	const { useMutation } = await import("@tanstack/react-query");
	return {
		useRpcClient: () => ({ FolderCreate: mocks.create }),
		useEffectMutation: (options: Parameters<typeof useMutation>[0]) =>
			useMutation(options),
	};
});
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
	mocks.destinations.mockReset();
	mocks.create.mockReset();
	mocks.place.mockReset();
	mocks.destinations.mockResolvedValue([
		{
			name: "My Caps",
			location: { type: "personal" },
			folders: [],
			canCreateFolder: true,
		},
		{
			name: "Acme",
			location: { type: "organization" },
			folders: [{ id: folderId, name: "Team folder", parentId: null }],
			canCreateFolder: true,
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
	open = true,
) {
	await act(async () => {
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(MoveItemsDialog, {
					open,
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
function destination(name: string) {
	const element = [
		...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
	].find((candidate) => candidate.textContent?.startsWith(name));
	if (!element) throw new Error(`Destination not found: ${name}`);
	return element;
}
async function chooseTeam() {
	await act(async () => destination("Acme").click());
}
async function type(input: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	await act(async () => {
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("moving Caps from My Caps to a team location", () => {
	it("shows the team folder and explains sharing before submitting its destination", async () => {
		await render();
		expect(button("Move").disabled).toBe(true);
		await chooseTeam();
		expect(destination("Acme").getAttribute("aria-pressed")).toBe("true");
		expect(destination("My Caps").getAttribute("aria-pressed")).toBe("false");
		expect(document.body.textContent).toContain(
			"People in Acme will be able to watch it",
		);
		await act(async () => button("Team folder").click());
		await act(async () => button("Add to Acme").click());
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
		expect(button("Add to Acme").disabled).toBe(false);
		await act(async () => button("Add to Acme").click());
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
		await act(async () => button("Add to Acme").click());
		expect(mocks.place).toHaveBeenCalledWith({
			videoIds: [videoId],
			folderId: null,
			location: { type: "organization" },
			organizationId,
		});
	});

	it("keeps folder moves within their original location", async () => {
		await render({ type: "folder", folderId, currentParentId: null });
		expect(document.querySelector("[aria-pressed]")).toBeNull();
		expect(mocks.destinations).not.toHaveBeenCalled();
		expect(mocks.folders).toHaveBeenCalledWith({ type: "personal" });
	});
});

describe("reopening the Move dialog", () => {
	it("lists a folder created since it was last open", async () => {
		await render();
		await chooseTeam();
		expect(document.body.textContent).not.toContain("New team folder");
		await render(undefined, undefined, false);

		mocks.destinations.mockResolvedValue([
			{ name: "My Caps", location: { type: "personal" }, folders: [] },
			{
				name: "Acme",
				location: { type: "organization" },
				folders: [
					{ id: folderId, name: "Team folder", parentId: null },
					{
						id: Folder.FolderId.make("new-team-folder"),
						name: "New team folder",
						parentId: null,
					},
				],
			},
		]);
		await render();
		await chooseTeam();

		expect(mocks.destinations).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).toContain("New team folder");
	});
});

describe("creating a folder while moving", () => {
	it("creates the folder in the chosen space and selects it", async () => {
		const newFolderId = Folder.FolderId.make("seo-folder");
		mocks.create.mockResolvedValue(undefined);
		await render();
		await chooseTeam();
		await act(async () => button("New folder").click());
		const input = document.querySelector<HTMLInputElement>(
			'input[aria-label="New folder name"]',
		);
		if (!input) throw new Error("Folder name field missing");
		await type(input, "SEO");

		mocks.destinations.mockResolvedValue([
			{ name: "My Caps", location: { type: "personal" }, folders: [] },
			{
				name: "Acme",
				location: { type: "organization" },
				folders: [
					{ id: folderId, name: "Team folder", parentId: null },
					{ id: newFolderId, name: "SEO", parentId: null },
				],
				canCreateFolder: true,
			},
		]);
		await act(async () => button("Create").click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});

		const call = mocks.create.mock.calls[0]?.[0];
		expect(call?.name).toBe("SEO");
		expect(call?.color).toBe("normal");
		expect(call?.public).toBe(false);
		expect(call && Option.getOrNull(call.spaceId)).toBe("org");
		expect(call && Option.getOrNull(call.parentId)).toBeNull();

		await act(async () => button("Add to Acme").click());
		expect(mocks.place).toHaveBeenCalledWith({
			videoIds: [videoId],
			folderId: newFolderId,
			location: { type: "organization" },
		});
	});

	it("hides folder creation where the person cannot create folders", async () => {
		mocks.destinations.mockResolvedValue([
			{ name: "My Caps", location: { type: "personal" }, folders: [] },
			{
				name: "Acme",
				location: { type: "organization" },
				folders: [],
				canCreateFolder: false,
			},
		]);
		await render();
		await chooseTeam();
		expect(
			[...document.querySelectorAll("button")].some(
				(element) => element.textContent?.trim() === "New folder",
			),
		).toBe(false);
	});
});
