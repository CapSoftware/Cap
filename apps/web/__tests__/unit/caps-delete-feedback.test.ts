// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { Caps, type VideoData } from "@/app/(org)/dashboard/caps/Caps";

const mocks = vi.hoisted(() => ({
	deleteCap: vi.fn<(id: Video.VideoId) => Effect.Effect<void, Error>>(),
	refresh: vi.fn(),
}));
const runtime = ManagedRuntime.make(Layer.empty);

vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/EffectRuntime", async () => {
	const { makeUseEffectMutation } = await import("@/lib/effect-react-query");
	return {
		useRpcClient: () => ({ VideoDelete: mocks.deleteCap }),
		useEffectMutation: makeUseEffectMutation(() => runtime),
	};
});
vi.mock("@/lib/Queries/Analytics", () => ({
	useVideosAnalyticsQuery: () => ({ data: {}, isLoading: false }),
}));
vi.mock("@/components/ChromeRecorderButton", () => ({
	ChromeRecorderButton: () => null,
}));
vi.mock("@/components/VideoThumbnail", () => ({
	SeededThumbnailsProvider: ({ children }: { children: ReactNode }) => children,
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

const data: VideoData = ["cap-1", "cap-2"].map((id) => ({
	id: Video.VideoId.make(id),
	ownerId: "user-1",
	name: id,
	createdAt: new Date("2026-11-05T12:00:00Z"),
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
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient();
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Caps, {
					data,
					count: data.length,
					folders: [],
					analyticsEnabled: false,
				}),
			),
		);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	container.remove();
	for (const activeToast of toast.getToasts()) toast.dismiss(activeToast.id);
	vi.unstubAllGlobals();
});

afterAll(() => runtime.dispose());

describe("bulk delete feedback", () => {
	it.each([
		{ outcome: "success", failureCount: 0 },
		{ outcome: "partial failure", failureCount: 1 },
		{ outcome: "failure", failureCount: 2 },
	])("clears its loading toast after $outcome", async ({ failureCount }) => {
		const deletes = data.map(() =>
			Effect.runSync(Deferred.make<void, Error>()),
		);
		mocks.deleteCap.mockImplementation((id) => {
			const pending = deletes[data.findIndex((video) => video.id === id)];
			if (!pending) throw new Error(`Unexpected Cap ${id}`);
			return Deferred.await(pending);
		});
		const unrelatedId = toast.loading("Uploading another Cap");

		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "a", ctrlKey: true }),
			);
		});
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
		});
		await vi.waitFor(() => expect(mocks.deleteCap).toHaveBeenCalledTimes(2));
		const deletingToast = toast
			.getToasts()
			.find(
				(entry) => "title" in entry && entry.title === "Deleting 2 caps...",
			);
		expect(deletingToast).toMatchObject({ type: "loading" });
		expect(mocks.refresh).not.toHaveBeenCalled();

		await act(async () => {
			await Effect.runPromise(
				Effect.all(
					deletes.map((pending, index) =>
						index < failureCount
							? Deferred.fail(pending, new Error("Deletion failed"))
							: Deferred.succeed(pending, undefined),
					),
				),
			);
		});
		await vi.waitFor(() => {
			expect(
				toast
					.getToasts()
					.some(
						(entry) =>
							"type" in entry &&
							entry.type === (failureCount === 2 ? "error" : "success"),
					),
			).toBe(true);
		});

		expect(
			toast.getToasts().some((entry) => entry.id === deletingToast?.id),
		).toBe(false);
		expect(toast.getToasts().some((entry) => entry.id === unrelatedId)).toBe(
			true,
		);
		expect(mocks.refresh).toHaveBeenCalledTimes(failureCount === 2 ? 0 : 1);
	});
});
