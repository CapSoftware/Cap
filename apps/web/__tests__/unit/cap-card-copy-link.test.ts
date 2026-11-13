// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Children = { children?: React.ReactNode };

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	copy: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("@/lib/video-share-clipboard", () => ({
	copyRichVideoLink: mocks.copy,
	videoPreviewImageUrl: () => "https://cap.test/preview.png",
}));
vi.mock("sonner", () => ({
	toast: { success: mocks.success, error: mocks.error, promise: vi.fn() },
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
}));
vi.mock("@cap/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/ui")>();
	const passThrough = ({ children }: Children) =>
		React.createElement(React.Fragment, null, children);
	return {
		...actual,
		DropdownMenu: passThrough,
		DropdownMenuTrigger: passThrough,
		DropdownMenuContent: passThrough,
		DropdownMenuItem: ({
			children,
			onClick,
		}: Children & { onClick?: (event: unknown) => void }) =>
			React.createElement(
				"button",
				{
					type: "button",
					role: "menuitem",
					onClick: (event: React.MouseEvent) => onClick?.(event),
				},
				children,
			),
	};
});
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({}),
	useEffectMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: null,
		user: { id: "owner-1" },
		setUpgradeModalOpen: vi.fn(),
	}),
}));
vi.mock("@/app/s/[videoId]/_components/ProgressCircle", () => ({
	useUploadProgress: () => null,
}));
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({ webUrl: "https://cap.test" }),
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: Children) =>
		React.createElement(React.Fragment, null, children),
}));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("@/components/VideoThumbnail", () => ({
	VideoThumbnail: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/MoveItemsDialog", () => ({
	MoveItemsDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/PasswordDialog", () => ({
	PasswordDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/SettingsDialog", () => ({
	SettingsDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/SharingDialog", () => ({
	SharingDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCardContent", () => ({
	CapCardContent: () => null,
}));

import { CapCard } from "@/app/(org)/dashboard/caps/components/CapCard/CapCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.push.mockReset();
	mocks.copy.mockReset();
	mocks.success.mockReset();
	mocks.error.mockReset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const cap = {
	id: "abc123",
	ownerId: "owner-1",
	name: "Demo",
	createdAt: new Date("2026-11-01T00:00:00Z"),
	totalComments: 0,
	totalReactions: 0,
	sharedOrganizations: [],
	sharedSpaces: [],
	ownerName: "Owner",
	hasActiveUpload: false,
} as unknown as React.ComponentProps<typeof CapCard>["cap"];

const renderCard = () =>
	act(async () =>
		root.render(
			React.createElement(CapCard, {
				cap,
				analytics: 0,
				isLoadingAnalytics: false,
				userId: "owner-1",
			}),
		),
	);

const copyLinkItem = () => {
	const item = [
		...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
	].find((element) => element.textContent?.includes("Copy link"));
	if (!item) throw new Error("Copy link menu item is missing");
	return item;
};

describe("cap card copy link", () => {
	it("says the link was copied once the clipboard accepts it", async () => {
		mocks.copy.mockResolvedValue(undefined);
		await renderCard();
		await act(async () => copyLinkItem().click());

		expect(mocks.copy).toHaveBeenCalledOnce();
		expect(mocks.success).toHaveBeenCalledExactlyOnceWith(
			"Link copied to clipboard",
		);
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("says so instead when the clipboard refuses the copy", async () => {
		mocks.copy.mockRejectedValue(new Error("Clipboard unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await renderCard();
		await act(async () => copyLinkItem().click());

		expect(mocks.success).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
			"Couldn't copy the link. Please try again.",
		);
	});
});
