// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	videoDelete: vi.fn(),
	mutationOptions: undefined as
		| { mutationFn: (id: string) => unknown }
		| undefined,
	capCardProps: undefined as { onDelete?: () => void } | undefined,
}));

vi.mock("@fortawesome/free-solid-svg-icons", () => ({
	faBuilding: {},
	faUser: {},
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({ VideoDelete: mocks.videoDelete }),
	useEffectMutation: (options: { mutationFn: (id: string) => unknown }) => {
		mocks.mutationOptions = options;
		return { mutateAsync: mocks.mutateAsync, isPending: false };
	},
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCard", () => ({
	CapCard: (props: { onDelete?: () => void }) => {
		mocks.capCardProps = props;
		return null;
	},
}));

import { SharedCapCard } from "@/app/(org)/dashboard/spaces/[spaceId]/components/SharedCapCard";

const cap = {
	id: "video-1",
	ownerId: "owner-1",
	name: "Demo",
	createdAt: new Date("2026-11-01T00:00:00Z"),
	totalComments: 0,
	totalReactions: 0,
	ownerName: "Owner",
	isScreenshot: false,
	hasActiveUpload: false,
} as unknown as Parameters<typeof SharedCapCard>[0]["cap"];

describe("SharedCapCard delete", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		mocks.mutateAsync.mockReset();
		mocks.videoDelete.mockReset();
		mocks.capCardProps = undefined;
		mocks.mutationOptions = undefined;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (userId: string) =>
		act(() => {
			root.render(
				createElement(SharedCapCard, {
					cap,
					analytics: 0,
					isLoadingAnalytics: false,
					organizationName: "Org",
					userId,
				}),
			);
		});

	it("gives the owner a Delete Cap that deletes the video", () => {
		const request = new Promise<void>(() => {});
		mocks.mutateAsync.mockReturnValue(request);
		render("owner-1");

		const onDelete = mocks.capCardProps?.onDelete as
			| (() => Promise<void>)
			| undefined;
		expect(onDelete).toBeTypeOf("function");
		// CapCard keeps its confirm dialog pending until this settles.
		expect(onDelete?.()).toBe(request);
		expect(mocks.mutateAsync).toHaveBeenCalledWith("video-1");

		mocks.mutationOptions?.mutationFn("video-1");
		expect(mocks.videoDelete).toHaveBeenCalledWith("video-1");
	});

	it("gives other members no delete action", () => {
		render("member-2");

		expect(mocks.capCardProps).toBeDefined();
		expect(mocks.capCardProps?.onDelete).toBeUndefined();
	});
});
