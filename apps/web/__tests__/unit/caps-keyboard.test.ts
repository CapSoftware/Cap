// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Caps, type VideoData } from "@/app/(org)/dashboard/caps/Caps";

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
	pending: false,
	mutations: [] as Array<Record<string, unknown>>,
	toast: {
		loading: vi.fn(() => "bulk-delete-toast"),
		success: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@fortawesome/free-solid-svg-icons", () => ({
	faFolderPlus: {},
	faInfoCircle: {},
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({}),
	useEffectMutation: (options: Record<string, unknown>) => {
		mocks.mutations.push(options);
		return { mutate: mocks.mutate, isPending: mocks.pending };
	},
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
const render = () =>
	root.render(
		createElement(Caps, {
			data,
			count: 1,
			folders: [],
			analyticsEnabled: false,
		}),
	);
let container: HTMLDivElement;
let selection: HTMLButtonElement;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.mutate.mockClear();
	mocks.mutations.length = 0;
	mocks.pending = false;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => render());
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

	it.each(["dialog", "alertdialog"])(
		"ignores Delete and Backspace on a button inside a %s",
		(role) => {
			const dialog = document.createElement("div");
			dialog.setAttribute("role", role);
			const button = document.createElement("button");
			dialog.append(button);
			container.append(dialog);
			button.focus();
			for (const key of ["Backspace", "Delete"]) {
				const event = new KeyboardEvent("keydown", {
					key,
					bubbles: true,
					cancelable: true,
				});
				button.dispatchEvent(event);
				expect(event.defaultPrevented).toBe(false);
			}
			expect(mocks.mutate).not.toHaveBeenCalled();
		},
	);

	it("ignores Backspace in a contenteditable element", () => {
		const editor = document.createElement("div");
		editor.contentEditable = "true";
		Object.defineProperty(editor, "isContentEditable", { value: true });
		editor.tabIndex = 0;
		container.append(editor);
		editor.focus();
		editor.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Backspace",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(mocks.mutate).not.toHaveBeenCalled();
	});

	it("deletes once when Delete is held down", () => {
		selection.focus();
		for (const repeat of [false, true, true]) {
			selection.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Delete",
					repeat,
					bubbles: true,
					cancelable: true,
				}),
			);
		}
		expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith([data[0]?.id]);
	});

	it("waits for a running delete before deleting again", async () => {
		const press = () =>
			selection.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Delete",
					bubbles: true,
					cancelable: true,
				}),
			);
		mocks.pending = true;
		await act(async () => render());
		selection.focus();
		press();
		expect(mocks.mutate).not.toHaveBeenCalled();

		mocks.pending = false;
		await act(async () => render());
		press();
		expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith([data[0]?.id]);
	});

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

describe("bulk delete toast", () => {
	type Callback = (...args: unknown[]) => unknown;
	const bulkDelete = () => {
		const options = mocks.mutations.findLast(
			(mutation) => typeof mutation.onMutate === "function",
		);
		if (!options) throw new Error("Bulk delete mutation missing");
		return options as Record<"onMutate" | "onSuccess" | "onError", Callback>;
	};
	const ids = ["cap-1", "cap-2"];

	beforeEach(() => {
		for (const fn of Object.values(mocks.toast)) fn.mockClear();
	});

	it("replaces the loading toast with the result", async () => {
		const { onMutate, onSuccess } = bulkDelete();
		const toastId = onMutate(ids);
		expect(mocks.toast.loading).toHaveBeenCalledWith("Deleting 2 caps...");
		await act(async () => onSuccess({ success: 2 }, ids, toastId));
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Successfully deleted 2 caps",
			{ id: "bulk-delete-toast" },
		);
	});

	it("replaces the loading toast on a partial failure", async () => {
		const { onMutate, onSuccess } = bulkDelete();
		const toastId = onMutate(ids);
		await act(async () => onSuccess({ success: 1, error: 1 }, ids, toastId));
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Successfully deleted 1 cap, but failed to delete 1 cap",
			{ id: "bulk-delete-toast" },
		);
	});

	it("replaces the loading toast with the error", () => {
		const { onMutate, onError } = bulkDelete();
		onError(new Error("Failed to delete 2 caps"), ids, onMutate(ids));
		expect(mocks.toast.error).toHaveBeenCalledWith("Failed to delete 2 caps", {
			id: "bulk-delete-toast",
		});
	});
});
