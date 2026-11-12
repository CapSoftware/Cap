// @vitest-environment jsdom

import { ImageUpload } from "@cap/web-domain";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	created: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("@/actions/organization/update-space", () => ({
	updateSpace: mocks.update,
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/server", () => ({
	createSpace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { members: [], ownerIsPro: true },
		user: { isPro: true },
		setUpgradeModalOpen: vi.fn(),
	}),
}));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Card")),
	...(await import("../../../../packages/ui/src/components/Switch")),
	...(await import("../../../../packages/ui/src/components/LoadingSpinner")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
	...(await import("../../../../packages/ui/src/components/input/Form")),
	...(await import("../../../../packages/ui/src/components/input/Label")),
}));
vi.mock("@/components/SignedImageUrl", () => ({
	SignedImageUrl: ({ image }: { image: string }) =>
		createElement("span", { "data-preview-url": image }),
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children, content }: { children: ReactNode; content: string }) =>
		createElement("span", { title: content }, children),
}));
vi.mock(
	"@/app/(org)/dashboard/spaces/[spaceId]/components/MemberSelect",
	() => ({
		MemberSelect: () => null,
	}),
);
vi.mock("@/app/(org)/dashboard/_components/PublicCollectionField", () => ({
	PublicCollectionField: () => null,
}));

import { NewSpaceForm } from "@/app/(org)/dashboard/_components/Navbar/SpaceDialog";

const space = {
	id: "space-1",
	name: "Design",
	members: [],
	iconUrl: ImageUpload.ImageUrl.make("https://example.com/icon.png"),
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:replacement-icon",
		revokeObjectURL: vi.fn(),
	});
	mocks.update.mockResolvedValue({ success: true });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function render(value = space) {
	await act(async () => {
		root.render(
			createElement(NewSpaceForm, {
				edit: true,
				space: value,
				onSpaceCreated: mocks.created,
			}),
		);
	});
}

async function submit() {
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing space form");
	await act(async () => {
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});
	expect(mocks.update).toHaveBeenCalledOnce();
	return mocks.update.mock.calls[0]?.[0] as FormData;
}

async function removeIcon() {
	const button = container.querySelector<HTMLButtonElement>(
		'[title="Remove icon"] button',
	);
	if (!button) throw new Error("Missing remove icon button");
	await act(async () => button.click());
	expect(mocks.update).not.toHaveBeenCalled();
}

async function renameSpace(name: string) {
	const input = container.querySelector<HTMLInputElement>(
		'input[placeholder="Space name"]',
	);
	if (!input) throw new Error("Missing space name input");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, name);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function chooseIcon() {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("Missing icon upload input");
	const file = new File(["image"], "replacement.png", { type: "image/png" });
	Object.defineProperty(input, "files", { value: [file] });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	return file;
}

function previewUrl() {
	return container
		.querySelector("[data-preview-url]")
		?.getAttribute("data-preview-url");
}

describe("space settings icon edits", () => {
	it("keeps the current icon when saving other space settings", async () => {
		await render();
		const formData = await submit();
		expect(formData.has("removeIcon")).toBe(false);
		expect(formData.has("icon")).toBe(false);
		expect(mocks.created).toHaveBeenCalledOnce();
	});

	it("removes the current icon only after clicking Remove icon", async () => {
		await render();
		await removeIcon();
		const formData = await submit();
		expect(formData.get("removeIcon")).toBe("true");
		expect(formData.has("icon")).toBe(false);
	});

	it("uploads a replacement without requesting removal", async () => {
		await render();
		await removeIcon();
		const file = await chooseIcon();
		const formData = await submit();
		expect(formData.get("icon")).toBe(file);
		expect(formData.has("removeIcon")).toBe(false);
	});

	it("does not carry an icon removal to another space", async () => {
		await render();
		await removeIcon();
		await render({ ...space, id: "space-2", name: "Engineering" });
		expect(previewUrl()).toBe(space.iconUrl);
		const formData = await submit();
		expect(formData.get("id")).toBe("space-2");
		expect(formData.has("removeIcon")).toBe(false);
	});

	it("keeps a pending replacement when the same space is rendered again", async () => {
		await render();
		await removeIcon();
		const file = await chooseIcon();
		await render({ ...space, members: [] });
		expect(previewUrl()).toBe("blob:replacement-icon");
		const formData = await submit();
		expect(formData.get("icon")).toBe(file);
		expect(formData.has("removeIcon")).toBe(false);
	});

	it("keeps a pending removal when the same space is rendered again", async () => {
		await render();
		await removeIcon();
		await render({ ...space, members: [] });
		expect(previewUrl()).toBeUndefined();
		const formData = await submit();
		expect(formData.get("removeIcon")).toBe("true");
		expect(formData.has("icon")).toBe(false);
	});

	it("resets a replacement and its preview when switching spaces", async () => {
		await render();
		await removeIcon();
		await chooseIcon();
		await render({ ...space, id: "space-2", name: "Engineering" });
		expect(previewUrl()).toBe(space.iconUrl);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:replacement-icon");
		const formData = await submit();
		expect(formData.get("id")).toBe("space-2");
		expect(formData.has("icon")).toBe(false);
		expect(formData.has("removeIcon")).toBe(false);
	});

	it("preserves the rest of the draft on same-space rerenders", async () => {
		await render();
		await renameSpace("New design");
		await render({ ...space, members: [] });
		const formData = await submit();
		expect(formData.get("name")).toBe("New design");
	});

	it("initializes the draft from the next space when switching", async () => {
		await render();
		await renameSpace("Unsaved name");
		await render({ ...space, id: "space-2", name: "Engineering" });
		const formData = await submit();
		expect(formData.get("name")).toBe("Engineering");
	});
});
