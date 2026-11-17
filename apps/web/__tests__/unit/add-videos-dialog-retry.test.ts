// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AddVideosDialogBase, {
	type VideoData,
} from "@/app/(org)/dashboard/spaces/[spaceId]/components/AddVideosDialogBase";

vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/LoadingSpinner")),
	...(await import("../../../../packages/ui/src/components/LogoSpinner")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));
vi.mock(
	"@/app/(org)/dashboard/Contexts",
	async () => import("@/app/(org)/dashboard/DashboardContext"),
);
vi.mock("@rive-app/react-canvas", () => ({
	useRive: () => ({ RiveComponent: () => null }),
	Layout: class {},
	Fit: { Contain: "contain" },
}));

const newId = Video.VideoId.make("new-video");
const existingId = Video.VideoId.make("existing-video");
const videoData: VideoData[] = [newId, existingId].map((id) => ({
	id,
	name: id,
	ownerId: "owner",
	ownerName: "Owner",
	createdAt: new Date("2026-01-01"),
	totalComments: 0,
	totalReactions: 0,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 503 })),
	);
	vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media }));
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				this.callback(
					[
						{
							target,
							contentRect: new DOMRect(0, 0, 640, 300),
							borderBoxSize: [{ inlineSize: 640, blockSize: 300 }],
							contentBoxSize: [{ inlineSize: 640, blockSize: 300 }],
							devicePixelContentBoxSize: [],
						},
					],
					this,
				);
			}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(640);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
	vi.unstubAllGlobals();
});

function button(label: string) {
	const element = [...document.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(label),
	);
	if (!element) throw new Error(`Button not found: ${label}`);
	return element;
}

async function flushUpdates() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}

async function renderDialog(
	props: Parameters<typeof AddVideosDialogBase<string>>[0],
) {
	await act(async () => {
		root.render(
			createElement(
				TooltipProvider,
				null,
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(AddVideosDialogBase<string>, props),
				),
			),
		);
	});
}

it.each(["addition", "removal"])(
	"retries a failed %s without reversing the successful operation",
	async (failure) => {
		const membership = new Set([existingId]);
		const addVideos = vi.fn(async (_entityId: string, ids: Video.VideoId[]) => {
			for (const id of ids) membership.add(id);
			return { success: true };
		});
		const removeVideos = vi.fn(
			async (_entityId: string, ids: Video.VideoId[]) => {
				for (const id of ids) membership.delete(id);
				return { success: true };
			},
		);
		if (failure === "addition")
			addVideos.mockResolvedValueOnce({ success: false });
		else removeVideos.mockResolvedValueOnce({ success: false });
		const onClose = vi.fn();
		await renderDialog({
			open: true,
			onClose,
			entityId: "folder",
			entityName: "Demo folder",
			addVideos,
			removeVideos,
			getVideos: async () => ({ success: true, data: videoData }),
			getEntityVideoIds: async () => ({
				success: true,
				data: [...membership],
			}),
		});
		await flushUpdates();
		await act(async () => button(newId).click());
		await act(async () => button(existingId).click());
		await act(async () => button("Update videos").click());
		await flushUpdates();
		expect([...membership]).toEqual(
			failure === "addition" ? [] : [existingId, newId],
		);
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => button("Update videos").click());
		await flushUpdates();
		expect([...membership]).toEqual([newId]);
		expect(addVideos).toHaveBeenCalledTimes(failure === "addition" ? 2 : 1);
		expect(removeVideos).toHaveBeenCalledTimes(failure === "removal" ? 2 : 1);
		expect(removeVideos).toHaveBeenLastCalledWith("folder", [existingId]);
		expect(onClose).toHaveBeenCalledOnce();
	},
);

it.each([false, true])(
	"keeps reopened selections when the previous removal completes with success=%s",
	async (success) => {
		const membership = new Set([existingId]);
		const pending = Promise.withResolvers<{ success: boolean }>();
		const addVideos = vi.fn(async (_entityId: string, ids: Video.VideoId[]) => {
			for (const id of ids) membership.add(id);
			return { success: true };
		});
		const removeVideos = vi
			.fn(async (_entityId: string, ids: Video.VideoId[]) => {
				for (const id of ids) membership.delete(id);
				return { success: true };
			})
			.mockImplementationOnce(async (_entityId, ids) => {
				const result = await pending.promise;
				if (result.success) {
					for (const id of ids) membership.delete(id);
				}
				return result;
			});
		const onClose = vi.fn();
		const onVideosAdded = vi.fn();
		const props = {
			open: true,
			onClose,
			onVideosAdded,
			entityId: "folder",
			entityName: "Demo folder",
			addVideos,
			removeVideos,
			getVideos: async () => ({ success: true, data: videoData }),
			getEntityVideoIds: async () => ({
				success: true,
				data: [...membership],
			}),
		};
		await renderDialog(props);
		await flushUpdates();
		await act(async () => button(newId).click());
		await act(async () => button(existingId).click());
		await act(async () => button("Update videos").click());
		await flushUpdates();
		expect(removeVideos).toHaveBeenCalledOnce();
		await act(async () => button("Cancel").click());
		await renderDialog({ ...props, open: false });
		await renderDialog(props);
		await flushUpdates();
		await act(async () => button(newId).click());
		expect(document.body.textContent).toContain("1 video selected");
		await act(async () => pending.resolve({ success }));
		await flushUpdates();
		expect(document.body.textContent).toContain("1 video selected");
		expect(onClose).toHaveBeenCalledOnce();
		expect(onVideosAdded).toHaveBeenCalledTimes(success ? 1 : 0);
		await act(async () => button("Update videos").click());
		await flushUpdates();
		expect([...membership]).toEqual(success ? [] : [existingId]);
		expect(addVideos).toHaveBeenCalledOnce();
		expect(removeVideos).toHaveBeenLastCalledWith("folder", [newId]);
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onVideosAdded).toHaveBeenCalledTimes(success ? 2 : 1);
	},
);
