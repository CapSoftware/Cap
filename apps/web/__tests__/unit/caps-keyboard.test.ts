// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Caps, type VideoData } from "@/app/(org)/dashboard/caps/Caps";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@fortawesome/free-solid-svg-icons", () => ({
	faFolderPlus: {},
	faInfoCircle: {},
}));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: {} }));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({}),
	useEffectMutation: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("@/lib/Queries/Analytics", () => ({
	useVideosAnalyticsQuery: () => ({ data: {}, isLoading: false }),
}));
vi.mock("@/components/ChromeRecorderButton", () => ({
	ChromeRecorderButton: () => null,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingStatus: () => [false, null],
}));
vi.mock("@/app/(org)/dashboard/caps/components", () => ({
	NewFolderDialog: () => null,
	SelectedCapsBar: () => null,
	UploadCapButton: () => null,
	UploadPlaceholderCard: () => null,
	WebRecorderDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCard", () => ({
	CapCard: ({
		onSelectToggle,
		isSelected,
	}: {
		onSelectToggle: () => void;
		isSelected: boolean;
	}) =>
		createElement("button", {
			type: "button",
			"aria-label": "Select Cap",
			"aria-pressed": isSelected,
			onClick: onSelectToggle,
		}),
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

const data: VideoData = [
	{
		id: "cap-1" as VideoData[number]["id"],
		ownerId: "user-1",
		name: "Demo",
		createdAt: new Date("2026-10-24T12:00:00Z"),
		public: false,
		totalComments: 0,
		totalReactions: 0,
		foldersData: [],
		sharedOrganizations: [],
		ownerName: "Test user",
		source: { type: "local" },
		isScreenshot: false,
		hasPassword: false,
		hasActiveUpload: false,
	},
];

let root: Root;
let container: HTMLDivElement;
let selection: HTMLButtonElement;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.mutate.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(Caps, {
				data,
				count: 1,
				folders: [],
				analyticsEnabled: false,
			}),
		);
	});
	const button = container.querySelector<HTMLButtonElement>("button");
	if (!button) throw new Error("Selection button missing");
	selection = button;
	await act(async () => selection.click());
	expect(selection.getAttribute("aria-pressed")).toBe("true");
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("Cap selection keyboard shortcuts", () => {
	it.each(["input", "textarea", "select"] as const)(
		"preserves Backspace editing in a focused %s",
		(tag) => {
			const control = document.createElement(tag);
			container.append(control);
			control.focus();
			const event = new KeyboardEvent("keydown", {
				key: "Backspace",
				bubbles: true,
				cancelable: true,
			});
			control.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
			expect(mocks.mutate).not.toHaveBeenCalled();
		},
	);

	it.each(["Backspace", "Delete"])(
		"still deletes the selected Cap with %s outside editing controls",
		(key) => {
			selection.focus();
			const event = new KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
			});
			selection.dispatchEvent(event);
			expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith([data[0]?.id]);
			expect(event.defaultPrevented).toBe(key === "Backspace");
		},
	);
});
