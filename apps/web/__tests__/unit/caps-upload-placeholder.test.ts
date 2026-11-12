// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import type { Store } from "@tanstack/store";
import {
	act,
	createElement,
	type ReactNode,
	useEffect,
	useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Caps, type VideoData } from "@/app/(org)/dashboard/caps/Caps";
import {
	UploadingProvider,
	type UploadStatus,
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";

vi.mock("@tanstack/react-store", () => ({
	useStore: <State, Selected>(
		store: Store<State>,
		select: (state: State) => Selected,
	) => {
		const state = useSyncExternalStore(store.subscribe, () => store.state);
		return select(state);
	},
}));
const recorderMounts = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));

vi.mock("hooks/useCapChromeExtension", () => ({
	useCapChromeExtension: () => ({ isChromeBrowser: false, isInstalled: false }),
}));
vi.mock("@/lib/rive", () => ({
	useRive: () => ({ RiveComponent: () => null }),
}));
vi.mock("@/app/(org)/dashboard/caps/components/UploadCapButton", () => ({
	UploadCapButton: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-dialog",
	() => ({
		WebRecorderDialog: () => {
			useEffect(() => {
				recorderMounts.mount();
				return () => {
					recorderMounts.unmount();
				};
			}, []);
			return null;
		},
	}),
);
vi.mock("@cap/ui", () => ({
	Button: () => null,
	LogoSpinner: () => null,
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
	useEffectMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
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
	useTheme: () => ({ theme: "light" }),
}));
vi.mock("@/app/(org)/dashboard/caps/components", async () => ({
	NewFolderDialog: () => null,
	SelectedCapsBar: () => null,
	UploadCapButton: () => null,
	UploadPlaceholderCard: (
		await import("@/app/(org)/dashboard/caps/components/UploadPlaceholderCard")
	).UploadPlaceholderCard,
	WebRecorderDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCard", () => ({
	CapCard: ({ cap }: { cap: VideoData[number] }) =>
		createElement("article", { "aria-label": cap.name }, cap.name),
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapPagination", () => ({
	CapPagination: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/FoldersSection", () => ({
	FoldersSection: () => null,
}));

const video: VideoData[number] = {
	id: Video.VideoId.make("cap-1"),
	ownerId: "user-1",
	name: "First Cap",
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
	hasActiveUpload: true,
};

let root: Root;
let container: HTMLDivElement;
let setUploadStatus: (status: UploadStatus | undefined) => void;

function UploadControls() {
	setUploadStatus = useUploadingContext().setUploadStatus;
	return null;
}

async function renderCaps(data: VideoData = []) {
	await act(async () => {
		root.render(
			createElement(
				UploadingProvider,
				null,
				createElement(UploadControls),
				createElement(Caps, {
					data,
					count: data.length,
					folders: [],
					analyticsEnabled: false,
				}),
			),
		);
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("Caps upload placeholder", () => {
	it("shows progress when the first upload starts in an empty library", async () => {
		await renderCaps();
		expect(container.textContent).toContain("Record your first Cap");

		await act(async () => setUploadStatus({ status: "creating" }));

		expect(container.textContent).toContain("Creating");
		expect(recorderMounts.mount).toHaveBeenCalledTimes(1);
		expect(recorderMounts.unmount).not.toHaveBeenCalled();
	});

	it("keeps progress visible when the uploading Cap is the only server row", async () => {
		await renderCaps();
		await act(async () =>
			setUploadStatus({
				status: "uploadingVideo",
				capId: video.id,
				progress: 50,
				thumbnailUrl: "blob:thumbnail",
			}),
		);
		await renderCaps([video]);

		expect(container.textContent).toContain("Uploading");
		expect(container.querySelectorAll("article")).toHaveLength(0);

		await act(async () => setUploadStatus(undefined));

		expect(container.textContent).not.toContain("Uploading");
		expect(container.querySelector("article")?.textContent).toBe(video.name);
	});

	it("returns to the empty state after an upload fails before creating a Cap", async () => {
		await renderCaps();
		await act(async () => setUploadStatus({ status: "parsing" }));

		expect(container.textContent).toContain("Parsing");

		await act(async () => setUploadStatus(undefined));

		expect(container.textContent).toContain("Record your first Cap");
		expect(container.textContent).not.toContain("Parsing");
	});

	it("keeps completed Caps visible alongside an upload", async () => {
		await renderCaps([video]);
		await act(async () =>
			setUploadStatus({ status: "serverProcessing", capId: "cap-2" }),
		);

		expect(container.textContent).toContain("Processing...");
		expect(container.querySelector("article")?.textContent).toBe(video.name);
	});
});
