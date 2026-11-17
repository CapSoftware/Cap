// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Caps } from "@/app/(org)/dashboard/caps/Caps";

vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));
vi.mock("@/components/ChromeRecorderButton", () => ({
	ChromeRecorderButton: () => null,
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/VideoThumbnail", () => ({
	SeededThumbnailsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useEffectMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useRpcClient: () => ({}),
}));
vi.mock("@/lib/Queries/Analytics", () => ({
	useVideosAnalyticsQuery: () => ({ data: {}, isLoading: false }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingStatus: () => [false, null],
}));
vi.mock("@/app/(org)/dashboard/caps/components", () => ({
	NewFolderDialog: () => null,
	UploadCapButton: () => null,
	UploadPlaceholderCard: () => null,
	WebRecorderDialog: () => null,
	SelectedCapsBar: ({ selectedCaps }: { selectedCaps: string[] }) =>
		createElement("output", { "data-testid": "selected" }, selectedCaps.length),
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCard", () => ({
	CapCard: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapPagination", () => ({
	CapPagination: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/EmptyCapState", () => ({
	EmptyCapState: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));

const makeCap = (id: string) => ({ id, name: id }) as never;

describe("caps select-all shortcut", () => {
	let root: Root;
	let container: HTMLDivElement;

	const selectedCount = () =>
		container.querySelector("output")?.textContent ?? "";

	const pressSelectAll = (target: Element, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key: "a",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			target.dispatchEvent(event);
		});
		return event;
	};

	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () =>
			root.render(
				createElement(Caps, {
					data: [makeCap("a"), makeCap("b"), makeCap("c")] as never,
					count: 3,
					folders: [],
					analyticsEnabled: false,
				}),
			),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		document.body.innerHTML = "";
		vi.unstubAllGlobals();
	});

	it("selects every cap when focus is on the page", () => {
		const event = pressSelectAll(document.body);
		expect(selectedCount()).toBe("3");
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves selection alone when focus is inside a dialog", () => {
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const button = document.createElement("button");
		dialog.append(button);
		document.body.append(dialog);
		button.focus();
		const event = pressSelectAll(button);
		expect(selectedCount()).toBe("0");
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves selection alone when focus is in a contenteditable element", () => {
		const editable = document.createElement("div");
		editable.tabIndex = 0;
		Object.defineProperty(editable, "isContentEditable", { value: true });
		document.body.append(editable);
		editable.focus();
		const event = pressSelectAll(editable);
		expect(selectedCount()).toBe("0");
		expect(event.defaultPrevented).toBe(false);
	});
});
