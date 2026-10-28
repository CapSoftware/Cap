// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import moment from "moment";
import {
	act,
	createElement,
	Profiler,
	type ProfilerOnRenderCallback,
	type PropsWithChildren,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { Caps, type VideoData } from "@/app/(org)/dashboard/caps/Caps";
import { makeUseEffectMutation } from "@/lib/effect-react-query";

const mocks = vi.hoisted(() => ({
	analytics: {} as Record<string, number>,
	loading: false,
	cardRender: vi.fn(),
	editTitle: vi.fn(),
	editDate: vi.fn(),
	toastError: vi.fn(),
	deleteVideo: vi.fn(),
	confirmations: new Map<string, () => void>(),
}));

vi.mock("@cap/env", () => ({ buildEnv: {}, NODE_ENV: "test" }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
	default: ({ children, ...props }: PropsWithChildren<{ href: string }>) =>
		createElement("a", props, children),
}));
vi.mock("@cap/ui", () => ({
	Button: ({
		children,
		onClick,
		...props
	}: PropsWithChildren<{ onClick?: () => void; "aria-label"?: string }>) =>
		createElement(
			"button",
			{ type: "button", onClick, "aria-label": props["aria-label"] },
			children,
		),
	DropdownMenu: ({ children }: PropsWithChildren) => children,
	DropdownMenuTrigger: ({ children }: PropsWithChildren) => children,
	DropdownMenuContent: () => null,
	DropdownMenuItem: () => null,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => {
	const context = {
		user: { id: "owner", isPro: true },
		setUpgradeModalOpen: vi.fn(),
	};
	return { useDashboardContext: () => context };
});
vi.mock("@/lib/EffectRuntime", async () => {
	const { makeUseEffectMutation, makeUseEffectQuery } = await import(
		"@/lib/effect-react-query"
	);
	const runtime = ManagedRuntime.make(Layer.empty);
	return {
		useRpcClient: () => ({
			GetUploadProgress: () => Effect.succeed(Option.none()),
			VideoDelete: (id: string) =>
				Effect.sync(() => {
					mocks.deleteVideo(id);
				}),
		}),
		useEffectMutation: makeUseEffectMutation(() => runtime),
		useEffectQuery: makeUseEffectQuery(() => runtime),
	};
});
vi.mock("@/lib/Queries/Analytics", () => ({
	useVideosAnalyticsQuery: () => ({
		data: mocks.analytics,
		isLoading: mocks.loading,
	}),
}));
vi.mock(
	"@/app/s/[videoId]/_components/ProgressCircle",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@/app/s/[videoId]/_components/ProgressCircle")
			>();
		return {
			...actual,
			useUploadProgress: (
				...args: Parameters<typeof actual.useUploadProgress>
			) => {
				mocks.cardRender(args[0]);
				return actual.useUploadProgress(...args);
			},
		};
	},
);
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({ webUrl: "https://cap.test" }),
}));
vi.mock("@/lib/Requests/ThumbnailRequest", () => ({
	ThumbnailRequest: { queryKey: (id: string) => [id] },
}));
vi.mock("@/lib/video-share-clipboard", () => ({
	copyRichVideoLink: vi.fn(),
	videoPreviewImageUrl: vi.fn(),
}));
vi.mock("@/actions/videos/edit-title", () => ({ editTitle: mocks.editTitle }));
vi.mock("@/actions/videos/edit-date", () => ({ editDate: mocks.editDate }));
vi.mock("sonner", () => ({
	toast: { error: mocks.toastError, success: vi.fn(), loading: vi.fn() },
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/components/VideoThumbnail", () => ({ VideoThumbnail: () => null }));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("@/components/ChromeRecorderButton", () => ({
	ChromeRecorderButton: () => null,
}));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: ({
		description,
		onConfirm,
	}: {
		description: string;
		onConfirm: () => void;
	}) => {
		mocks.confirmations.set(description, onConfirm);
		return null;
	},
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
vi.mock("@/app/(org)/dashboard/caps/components", () => ({
	NewFolderDialog: () => null,
	SelectedCapsBar: () => null,
	UploadCapButton: () => null,
	UploadPlaceholderCard: () => null,
	WebRecorderDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapPagination", () => ({
	CapPagination: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/EmptyCapState", () => ({
	EmptyCapState: () => "Empty",
}));
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingStatus: () => [false, null],
}));

let renderDuration = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, duration) => {
	renderDuration += duration;
};
let root: Root;
let queryClient: QueryClient;
let container: HTMLDivElement;
let contentRender: MockInstance<typeof moment.fn.fromNow>;
const makeVideos = (size: number): VideoData =>
	Array.from({ length: size }, (_, index) => ({
		id: `video-${index}` as VideoData[number]["id"],
		ownerId: "owner",
		ownerName: "Owner",
		name: `Recording ${index}`,
		createdAt: new Date("2026-10-20T12:00:00Z"),
		public: true,
		totalComments: 2,
		totalReactions: 3,
		foldersData: [],
		sharedOrganizations: [],
		source: { type: "desktopMP4" },
		isScreenshot: false,
		hasPassword: false,
		hasActiveUpload: false,
	}));

async function render(data: VideoData) {
	await act(async () =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(
					Profiler,
					{ id: import.meta.url, onRender },
					createElement(Caps, {
						data,
						count: data.length,
						folders: [],
						analyticsEnabled: true,
					}),
				),
			),
		),
	);
}
async function click(selector: string) {
	const button = container.querySelector<HTMLButtonElement>(selector);
	if (!button) throw new Error(`Missing ${selector}`);
	await act(async () => button.click());
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	contentRender = vi.spyOn(moment.fn, "fromNow");
	mocks.confirmations.clear();
	mocks.analytics = {};
	mocks.loading = false;
	container = document.createElement("div");
	document.body.append(container);
	queryClient = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { staleTime: Infinity, retry: false },
		},
	});
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	container.remove();
	vi.unstubAllGlobals();
});

it("keeps unchanged cards out of parent drag and analytics updates", async () => {
	const data = makeVideos(50);
	await render(data);
	mocks.cardRender.mockClear();
	await act(async () => window.dispatchEvent(new Event("dragstart")));
	expect(mocks.cardRender).toHaveBeenCalledTimes(0);
	mocks.analytics = { "video-0": 29 };
	await render(data);
	expect(mocks.cardRender.mock.calls.map(([id]) => id)).toEqual(["video-0"]);
	expect(container.textContent).toContain("29");
});

it("preserves selection and the current bulk-delete selection", async () => {
	const data = makeVideos(3);
	await render(data);
	await click('button[aria-label="Select cap"]');
	await click(
		'fieldset[aria-label="Recording 1"] button[aria-label="Select cap"]',
	);
	expect(
		container.querySelectorAll('button[aria-label="Deselect cap"]'),
	).toHaveLength(2);
	await act(async () =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })),
	);
	expect(mocks.deleteVideo.mock.calls).toEqual([["video-0"], ["video-1"]]);
	await act(async () =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
	);
	expect(
		container.querySelectorAll('button[aria-label="Deselect cap"]'),
	).toHaveLength(0);
});

it("skips static content work on selection and preserves unchanged card markup", async () => {
	const data = makeVideos(3);
	await render(data);
	const markup = container.querySelector(
		'fieldset[aria-label="Recording 2"]',
	)?.innerHTML;
	contentRender.mockClear();
	await click('button[aria-label="Select cap"]');
	expect(contentRender).not.toHaveBeenCalled();
	await act(async () =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
	);
	expect(
		container.querySelector('fieldset[aria-label="Recording 2"]')?.innerHTML,
	).toBe(markup);
	mocks.loading = true;
	await render(data);
	expect(container.querySelectorAll(".animate-pulse")).toHaveLength(9);
	mocks.loading = false;
	mocks.analytics = { "video-0": 42 };
	await render(data);
	expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
	expect(
		container.querySelector('fieldset[aria-label="Recording 2"]')?.innerHTML,
	).toBe(markup);
	expect(
		container.querySelector('fieldset[aria-label="Recording 0"]')?.textContent,
	).toContain("42");
	await render(
		data.map((cap) => ({ ...cap, public: false, totalComments: 19 })),
	);
	expect(container.textContent).toContain("Not shared");
	expect(container.textContent).toContain("19");
});

it("keeps title editing and date validation responsive after parent updates", async () => {
	const data = makeVideos(1);
	await render(data);
	mocks.analytics = { "video-0": 12 };
	await render(data);
	const title = Array.from(container.querySelectorAll("p")).find(
		(node) => node.textContent === "Recording 0",
	);
	if (!title) throw new Error("Missing title");
	await act(async () => title.click());
	const input = container.querySelector("textarea");
	if (!input) throw new Error("Missing title input");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(input, "Renamed recording");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () =>
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
	);
	expect(mocks.editTitle).toHaveBeenCalledWith("video-0", "Renamed recording");
	expect(container.textContent).toContain("Renamed recording");
	const date = container.querySelector<HTMLParagraphElement>(
		'p[class*="cursor-pointer flex items-center"]',
	);
	if (!date) throw new Error("Missing date");
	await act(async () => date.click());
	const dateInput = container.querySelector("input");
	if (!dateInput) throw new Error("Missing date input");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(dateInput, "2026-13-40 12:00:00");
		dateInput.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () =>
		dateInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		),
	);
	expect(mocks.editDate).not.toHaveBeenCalled();
	expect(mocks.toastError).toHaveBeenCalledWith(
		"Invalid date format. Please use YYYY-MM-DD HH:mm:ss",
	);
	expect(container.querySelector("input")).toBeNull();
});

it("deletes the clicked card and uses the latest selection for bulk deletion", async () => {
	await render(makeVideos(3));
	async function confirm() {
		const onConfirm = mocks.confirmations.get(
			'Are you sure you want to delete the cap "Recording 1"? This action cannot be undone.',
		);
		if (!onConfirm) throw new Error("Missing delete confirmation");
		await act(async () => onConfirm());
	}
	await confirm();
	await vi.waitFor(() =>
		expect(mocks.deleteVideo.mock.calls).toEqual([["video-1"]]),
	);
	mocks.deleteVideo.mockClear();
	await click('button[aria-label="Select cap"]');
	await click(
		'fieldset[aria-label="Recording 1"] button[aria-label="Select cap"]',
	);
	await confirm();
	await vi.waitFor(() =>
		expect(mocks.deleteVideo.mock.calls).toEqual([["video-0"], ["video-1"]]),
	);
});

it("keeps the Effect mutate callback stable and forwards success and error callbacks", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const useMutation = makeUseEffectMutation(() => runtime);
	const exposed: {
		mutate?: (
			value: number,
			options?: { onSuccess?: () => void; onError?: () => void },
		) => void;
		read?: () => unknown;
	} = {};
	function Probe() {
		const mutation = useMutation({
			mutationFn: (value: number) =>
				value < 0
					? Effect.fail("failed")
					: Effect.sync(() => {
							mocks.deleteVideo(value);
						}),
		});
		exposed.mutate = mutation.mutate;
		exposed.read = () => mutation.mutate;
		return null;
	}
	const renderProbe = () =>
		act(async () =>
			root.render(
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(Probe),
				),
			),
		);
	try {
		await renderProbe();
		const mutate = exposed.mutate;
		if (!mutate) throw new Error("Missing mutation");
		expect(exposed.read?.()).toBe(mutate);
		await renderProbe();
		expect(exposed.mutate).toBe(mutate);
		const onSuccess = vi.fn();
		await act(async () => mutate(4, { onSuccess }));
		await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
		expect(mocks.deleteVideo).toHaveBeenCalledWith(4);
		const onError = vi.fn();
		await act(async () => mutate(-1, { onError }));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(mocks.deleteVideo).not.toHaveBeenCalledWith(-1);
	} finally {
		await runtime.dispose();
	}
});

function uploadSnapshot(uploaded: number) {
	return {
		phase: "uploading",
		uploaded,
		total: 100,
		updatedAt: new Date(),
		processingProgress: 0,
	};
}
async function updateUpload(uploaded: number) {
	await act(async () => {
		queryClient.setQueryData(
			["getUploadProgress", "video-0"],
			uploadSnapshot(uploaded),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

it("updates only the uploading card and keeps its metadata out of progress renders", async () => {
	const data = makeVideos(50).map((cap, index) =>
		index === 0 ? { ...cap, hasActiveUpload: true } : cap,
	);
	queryClient.setQueryData(
		["getUploadProgress", "video-0"],
		uploadSnapshot(10),
	);
	await render(data);
	mocks.cardRender.mockClear();
	contentRender.mockClear();
	await updateUpload(25);
	expect(mocks.cardRender.mock.calls.map(([id]) => id)).toEqual(["video-0"]);
	expect(contentRender).not.toHaveBeenCalled();
	expect(
		container.querySelector('fieldset[aria-label="Recording 0"]')?.textContent,
	).toContain("25%");
});

it.skipIf(!process.env.CAP_GRID_BENCH)(
	"measures grid update medians",
	async () => {
		for (const size of [15, 50, 200]) {
			const data = makeVideos(size);
			await render(data);
			for (const kind of [
				"drag",
				"analytics",
				"selection",
				"upload",
			] as const) {
				if (kind === "upload") {
					queryClient.setQueryData(
						["getUploadProgress", "video-0"],
						uploadSnapshot(10),
					);
					await render(
						data.map((cap, index) =>
							index === 0 ? { ...cap, hasActiveUpload: true } : cap,
						),
					);
				}
				const times: number[] = [];
				const renderTimes: number[] = [];
				const renders: number[] = [];
				const contentRenders: number[] = [];
				for (let sample = 0; sample < 9; sample++) {
					mocks.cardRender.mockClear();
					contentRender.mockClear();
					renderDuration = 0;
					const start = performance.now();
					if (kind === "drag") {
						await act(async () =>
							window.dispatchEvent(
								new Event(sample % 2 ? "dragend" : "dragstart"),
							),
						);
					} else if (kind === "analytics") {
						mocks.analytics = { "video-0": sample + 10 };
						await render(data);
					} else if (kind === "upload") {
						await updateUpload(sample + 11);
					} else {
						await click(
							'fieldset[aria-label="Recording 1"] button[aria-label="Select cap"], fieldset[aria-label="Recording 1"] button[aria-label="Deselect cap"]',
						);
					}
					if (sample > 1) {
						times.push(performance.now() - start);
						renderTimes.push(renderDuration);
						renders.push(mocks.cardRender.mock.calls.length);
						contentRenders.push(contentRender.mock.calls.length);
					}
				}
				times.sort((a, b) => a - b);
				renderTimes.sort((a, b) => a - b);
				renders.sort((a, b) => a - b);
				contentRenders.sort((a, b) => a - b);
				console.log(
					JSON.stringify({
						size,
						kind,
						medianMs: times[Math.floor(times.length / 2)],
						medianRenderMs: renderTimes[Math.floor(renderTimes.length / 2)],
						cardRenders: renders[Math.floor(renders.length / 2)],
						contentRenders:
							contentRenders[Math.floor(contentRenders.length / 2)],
					}),
				);
			}
			await render(data);
			console.log(
				JSON.stringify({
					size,
					outputHash: createHash("sha256")
						.update(container.innerHTML)
						.digest("hex"),
				}),
			);
			await act(async () => root.render(null));
		}
	},
	300000,
);
