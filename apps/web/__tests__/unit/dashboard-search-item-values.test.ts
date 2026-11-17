// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardSearch } from "@/app/(org)/dashboard/_components/Navbar/DashboardSearch";
import type { DashboardVideoSearchResult } from "@/app/(org)/dashboard/_components/Navbar/search";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	searchDashboardVideos: vi.fn(),
	spacesData: [] as Array<Record<string, unknown>>,
}));

vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Cmdk")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard/caps",
	useRouter: () => ({ push: mocks.push }),
}));
vi.mock("hooks/useDetectPlatform", () => ({
	useDetectPlatform: () => ({ platform: "macos" }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: {
			organization: { id: "org", ownerId: "user" },
			members: [{ userId: "user", role: "owner" }],
		},
		spacesData: mocks.spacesData,
		user: { id: "user" },
	}),
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/search", () => ({
	searchDashboardVideos: mocks.searchDashboardVideos,
}));

const hostileText: Array<[string, string]> = [
	["double quotes", 'Say "hello" to the team'],
	["a backslash", "C:\\Users\\demo\\"],
	["a closing bracket", 'Sprint review "] done'],
	["a newline", "Line one\nLine two"],
];

const video = (id: string, name: string, ownerName = "Sam") =>
	({
		id,
		name,
		ownerName,
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 65,
		isScreenshot: false,
	}) as DashboardVideoSearchResult;

const space = (id: string, name: string) => ({
	id,
	name,
	description: name,
	privacy: "Public",
	primary: false,
	videoCount: 1,
	memberCount: 1,
});

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
	Element.prototype.scrollIntoView = () => {};
	mocks.spacesData = [];
	mocks.searchDashboardVideos.mockResolvedValue([]);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const settle = (ms = 0) =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});

const items = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];

const selectedItems = () =>
	items().filter((item) => item.getAttribute("aria-selected") === "true");

const input = () => {
	const element = document.querySelector<HTMLInputElement>("[cmdk-input]");
	if (!element) throw new Error("Search input not found");
	return element;
};

async function openSearch() {
	await act(async () => {
		root.render(createElement(DashboardSearch));
	});
	await act(async () => {
		document
			.querySelector<HTMLButtonElement>('[aria-label="Search dashboard"]')
			?.click();
	});
	await settle();
}

async function type(value: string) {
	await act(async () => {
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setValue?.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
	await settle(250);
}

async function hover(row: HTMLElement | undefined) {
	if (!row) throw new Error("Result row not found");
	await act(async () => {
		row.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
	});
	await settle();
}

async function press(key: string) {
	await act(async () => {
		input().dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
		);
	});
	await settle();
}

describe("dashboard search results", () => {
	it.each(hostileText)(
		"renders and opens a video whose title has %s",
		async (_label, name) => {
			mocks.searchDashboardVideos.mockResolvedValue([video("video-1", name)]);
			await openSearch();
			await type("se");

			const row = items().find((item) => item.textContent?.includes("Sam"));
			await hover(row);
			expect(selectedItems()).toEqual([row]);
			expect(input().getAttribute("aria-activedescendant")).toBe(row?.id);

			await press("Enter");
			expect(mocks.push).toHaveBeenCalledWith("/s/video-1");
		},
	);

	it.each(hostileText)(
		"renders a video whose owner name has %s",
		async (_label, ownerName) => {
			mocks.searchDashboardVideos.mockResolvedValue([
				video("video-1", "Weekly sync", ownerName),
			]);
			await openSearch();
			await type("we");

			const row = items().find((item) =>
				item.textContent?.includes("Weekly sync"),
			);
			await hover(row);
			expect(selectedItems()).toEqual([row]);
			expect(input().getAttribute("aria-activedescendant")).toBe(row?.id);
		},
	);

	it.each(hostileText)(
		"renders and opens a space whose name has %s",
		async (_label, name) => {
			mocks.spacesData = [space("space-1", name)];
			await openSearch();

			const row = items().find((item) =>
				item.textContent?.includes("1 video · 1 member"),
			);
			await hover(row);
			expect(selectedItems()).toEqual([row]);
			expect(input().getAttribute("aria-activedescendant")).toBe(row?.id);

			await press("Enter");
			expect(mocks.push).toHaveBeenCalledWith("/dashboard/spaces/space-1");
		},
	);

	it("keeps videos with identical titles and owners separately selectable", async () => {
		mocks.searchDashboardVideos.mockResolvedValue([
			video("video-1", "Untitled"),
			video("video-2", "Untitled"),
		]);
		await openSearch();
		await type("un");

		const rows = items().filter((item) =>
			item.textContent?.includes("Untitled"),
		);
		expect(rows).toHaveLength(2);
		await hover(rows[1]);
		expect(selectedItems()).toEqual([rows[1]]);

		await press("Enter");
		expect(mocks.push).toHaveBeenCalledWith("/s/video-2");
	});
});
