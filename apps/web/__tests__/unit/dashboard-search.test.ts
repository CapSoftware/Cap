// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardVideoSearchResult } from "@/app/(org)/dashboard/_components/Navbar/search";

const mocks = vi.hoisted(() => ({
	searchDashboardVideos: vi.fn(),
	activeOrganizationId: "org-a",
}));

vi.mock("@cap/ui", () => {
	const passthrough = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Command: passthrough,
		CommandList: passthrough,
		DialogContent: passthrough,
		DialogTitle: passthrough,
		Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
			open ? createElement("div", null, children) : null,
		CommandInput: ({
			value,
			onValueChange,
		}: {
			value: string;
			onValueChange: (value: string) => void;
		}) =>
			createElement("input", {
				"aria-label": "Search query",
				value,
				onChange: (event: { target: { value: string } }) =>
					onValueChange(event.target.value),
			}),
		CommandItem: ({ children }: { children?: ReactNode }) =>
			createElement("div", { role: "option" }, children),
	};
});
vi.mock("hooks/useDetectPlatform", () => ({
	useDetectPlatform: () => ({ platform: "linux" }),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard/caps",
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: {
			organization: { id: mocks.activeOrganizationId, ownerId: "user-1" },
			members: [{ userId: "user-1", role: "owner" }],
		},
		spacesData: [],
		user: { id: "user-1" },
	}),
}));
vi.mock("@/app/(org)/dashboard/_components/Navbar/search", () => ({
	searchDashboardVideos: mocks.searchDashboardVideos,
}));

const { DashboardSearch } = await import(
	"@/app/(org)/dashboard/_components/Navbar/DashboardSearch"
);

const video = (id: string, name: string): DashboardVideoSearchResult => ({
	id: id as DashboardVideoSearchResult["id"],
	name,
	ownerName: "Owner",
	createdAt: "2026-10-24T12:00:00.000Z",
	duration: 30,
	isScreenshot: false,
});

describe("DashboardSearch", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		(
			globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.activeOrganizationId = "org-a";
		mocks.searchDashboardVideos.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	const render = () => act(() => root.render(createElement(DashboardSearch)));

	const toggleWithShortcut = () =>
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
			);
		});

	const typeQuery = (value: string) => {
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Search query"]',
		);
		if (!input) throw new Error("search input not rendered");
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		act(() => {
			setValue?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};

	const settleSearch = () =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

	it("searches again after reopening in another organization", async () => {
		mocks.searchDashboardVideos.mockResolvedValueOnce([
			video("video-a", "Org A launch demo"),
		]);
		render();
		toggleWithShortcut();
		typeQuery("demo");
		await settleSearch();

		expect(container.textContent).toContain("Org A launch demo");

		toggleWithShortcut();
		mocks.activeOrganizationId = "org-b";
		mocks.searchDashboardVideos.mockResolvedValueOnce([
			video("video-b", "Org B onboarding demo"),
		]);
		render();
		toggleWithShortcut();
		await settleSearch();

		expect(mocks.searchDashboardVideos).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Org B onboarding demo");
		expect(container.textContent).not.toContain("Org A launch demo");
	});

	it("reuses results for a repeated query while the dialog stays open", async () => {
		mocks.searchDashboardVideos.mockResolvedValue([
			video("video-a", "Org A launch demo"),
		]);
		render();
		toggleWithShortcut();
		typeQuery("demo");
		await settleSearch();
		typeQuery("demos");
		await settleSearch();
		typeQuery("demo");
		await settleSearch();

		expect(mocks.searchDashboardVideos).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Org A launch demo");
	});
});
