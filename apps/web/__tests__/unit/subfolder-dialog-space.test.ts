// @vitest-environment jsdom

import { Folder, Space } from "@cap/web-domain";
import { Option } from "effect";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	activeSpace: null as { id: string } | null,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/PublicCollectionField", () => ({
	PublicCollectionField: () => null,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeSpace: mocks.activeSpace,
		activeOrganization: { ownerIsPro: false },
		setUpgradeModalOpen: vi.fn(),
	}),
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({ FolderCreate: mocks.create }),
	useEffectMutation: (options: { mutationFn: (data: unknown) => unknown }) => ({
		mutate: (data: unknown) => options.mutationFn(data),
		isPending: false,
	}),
}));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));

import { SubfolderDialog } from "@/app/(org)/dashboard/folder/[id]/components/SubfolderDialog";

let root: Root;
let container: HTMLDivElement;
const parentFolderId = Folder.FolderId.make("space-folder");

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.create.mockReset();
	mocks.activeSpace = null;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.innerHTML = "";
});

async function createIn(spaceId?: Space.SpaceIdOrOrganisationId) {
	await act(async () => {
		root.render(
			React.createElement(SubfolderDialog, {
				open: true,
				onOpenChange: () => {},
				parentFolderId,
				spaceId,
			}),
		);
	});
	const input = document.querySelector<HTMLInputElement>(
		'input[placeholder="Subfolder name"]',
	);
	if (!input) throw new Error("Name field missing");
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	await act(async () => {
		setValue?.call(input, "Q3");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const buttons = [...document.querySelectorAll("button")];
	const color = buttons.find((b) => b.textContent?.trim() === "Blue");
	const create = buttons.find((b) => b.textContent?.trim() === "Create");
	if (!color || !create) throw new Error("Dialog buttons missing");
	await act(async () => color.click());
	await act(async () => create.click());
	return mocks.create.mock.calls[0]?.[0] as
		| { spaceId: Option.Option<string>; parentId: Option.Option<string> }
		| undefined;
}

describe("creating a subfolder inside a space folder", () => {
	it("uses the space from the route when the dashboard does not list it", async () => {
		const call = await createIn(Space.SpaceId.make("private-space"));

		expect(call && Option.getOrNull(call.spaceId)).toBe("private-space");
		expect(call && Option.getOrNull(call.parentId)).toBe("space-folder");
	});

	it("still uses the dashboard's space when no route space is given", async () => {
		mocks.activeSpace = { id: "listed-space" };
		const call = await createIn();

		expect(call && Option.getOrNull(call.spaceId)).toBe("listed-space");
	});
});
