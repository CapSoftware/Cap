// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPasteImport } from "@/app/(org)/dashboard/_components/DashboardPasteImport";

const mocks = vi.hoisted(() => ({
	importMediaFile: vi.fn(),
	push: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("@tanstack/react-store", () => ({ useStore: () => false }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { id: "org-123" } },
		setUpgradeModalOpen: vi.fn(),
		user: { isPro: true },
	}),
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({
		uploadingStore: {},
		setUploadStatus: vi.fn(),
	}),
}));
vi.mock("@/app/(org)/dashboard/import/import-media", () => ({
	importMediaFile: mocks.importMediaFile,
	isSupportedMediaFile: () => true,
}));

describe("DashboardPasteImport", () => {
	let root: Root;

	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		mocks.importMediaFile.mockReset();
		mocks.push.mockReset();
		mocks.refresh.mockReset();
		root = createRoot(document.createElement("div"));
		await act(async () => {
			root.render(createElement(DashboardPasteImport));
		});
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	});

	const paste = async () => {
		const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
		const event = new Event("paste", { cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: { items: [], files: [file] },
		});
		await act(async () => {
			window.dispatchEvent(event);
		});
	};

	it("refreshes the page so a failed import's deleted Cap disappears", async () => {
		mocks.importMediaFile.mockResolvedValue(false);
		await paste();

		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		expect(mocks.push).not.toHaveBeenCalled();
	});

	it("opens Caps after a successful import", async () => {
		mocks.importMediaFile.mockResolvedValue(true);
		await paste();

		expect(mocks.push).toHaveBeenCalledWith("/dashboard/caps");
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
