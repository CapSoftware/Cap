// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	type ReactNode,
	type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { Share } from "@/app/s/[videoId]/Share";

vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	type MotionProps = Record<string, unknown> & { children?: ReactNode };
	const strip = (props: MotionProps) => {
		const {
			layout: _layout,
			layoutId: _layoutId,
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			onLayoutAnimationStart: _onLayoutAnimationStart,
			onLayoutAnimationComplete: _onLayoutAnimationComplete,
			children,
			...rest
		} = props;
		return { children, rest };
	};
	const host =
		(tag: string) =>
		(props: MotionProps): ReactNode => {
			const { children, rest } = strip(props);
			return createElement(tag, rest, children);
		};
	return {
		AnimatePresence: ({ children }: { children?: ReactNode }) => children,
		useReducedMotion: () => false,
		motion: { div: host("div"), span: host("span") },
	};
});

vi.mock("next/dynamic", async () => {
	const { createElement } = await import("react");
	return {
		default: () => () => createElement("div", { "data-timeline-view": "" }),
	};
});

vi.mock("next/image", async () => {
	const { createElement } = await import("react");
	return {
		default: ({ alt }: { alt?: string }) => createElement("img", { alt }),
	};
});

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: undefined }),
}));

vi.mock("@/actions/videos/get-status", () => ({
	getVideoStatus: async () => ({}),
}));

vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	CaptionProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/app/s/[videoId]/_components/ShareVideo", async () => {
	const { createElement } = await import("react");
	return {
		ShareVideo: ({ ref }: { ref?: Ref<HTMLVideoElement> }) =>
			createElement("video", { ref, "data-share-video": "" }),
	};
});

vi.mock("@/app/s/[videoId]/_components/Sidebar", async () => {
	const { createElement } = await import("react");
	return { Sidebar: () => createElement("div", { "data-sidebar": "" }) };
});

vi.mock("@/app/s/[videoId]/_components/Toolbar", async () => {
	const { createElement } = await import("react");
	return { Toolbar: () => createElement("div", { "data-toolbar": "" }) };
});

vi.mock("@/app/s/[videoId]/_components/SummaryChapters", async () => {
	const { createElement } = await import("react");
	return { default: () => createElement("div", { "data-summary": "" }) };
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type ShareComponentProps = ComponentProps<typeof Share>;

const createProps = (
	overrides: Partial<ShareComponentProps> = {},
): ShareComponentProps => ({
	data: {
		id: "video-id",
		name: "Test video",
		orgId: "org-id",
		owner: { id: "owner-id", isPro: false },
		duration: 60,
		metadata: null,
		createdAt: new Date(),
		isScreenshot: false,
		transcriptionStatus: null,
		source: { type: "desktopMP4" },
		orgSettings: null,
	} as unknown as ShareComponentProps["data"],
	comments: [],
	views: 0,
	customDomain: null,
	domainVerified: false,
	// Matching the owner short-circuits the view-tracking beacon, which has no
	// business firing from a layout test.
	viewerId: "owner-id",
	isEditProcessing: false,
	aiGenerationAvailable: false,
	transcriptionGenerationAvailable: false,
	...overrides,
});

const findButton = (container: HTMLElement, label: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === label,
	);

/** The stage wrapper is three levels above the `<video>`: player -> inset box -> card -> stage. */
const stageOf = (video: Element | null) =>
	video?.parentElement?.parentElement?.parentElement ?? null;

describe("Share view toggle", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		document.body.replaceChildren();
		window.history.replaceState(window.history.state, "", "/s/video-id");
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("keeps the same stage and video element across view changes", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(createElement(Share, createProps()));
		});

		const video = container.querySelector("[data-share-video]");
		const stage = stageOf(video);
		expect(video).not.toBeNull();
		expect(stage).not.toBeNull();
		expect(container.querySelector("[data-sidebar]")).not.toBeNull();
		expect(container.querySelector("[data-toolbar]")).not.toBeNull();

		await act(async () => {
			findButton(container, "Timeline")?.click();
		});

		// The whole point of the grid refactor: the player is moved, never rebuilt.
		expect(container.querySelector("[data-share-video]")).toBe(video);
		expect(stageOf(container.querySelector("[data-share-video]"))).toBe(stage);
		expect(container.querySelector("[data-timeline-view]")).not.toBeNull();
		expect(container.querySelector("[data-sidebar]")).toBeNull();
		expect(container.querySelector("[data-toolbar]")).toBeNull();
		expect(window.location.search).toBe("?view=timeline");

		await act(async () => {
			findButton(container, "Player")?.click();
		});

		expect(container.querySelector("[data-share-video]")).toBe(video);
		expect(stageOf(container.querySelector("[data-share-video]"))).toBe(stage);
		expect(container.querySelector("[data-sidebar]")).not.toBeNull();
		expect(container.querySelector("[data-timeline-view]")).toBeNull();
		expect(window.location.search).toBe("");

		await act(async () => {
			root.unmount();
		});
	});

	it("starts on the timeline when the server resolves ?view=timeline", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				createElement(Share, createProps({ initialView: "timeline" })),
			);
		});

		expect(container.querySelector("[data-timeline-view]")).not.toBeNull();
		expect(container.querySelector("[data-share-video]")).not.toBeNull();
		expect(container.querySelector("[data-sidebar]")).toBeNull();

		await act(async () => {
			root.unmount();
		});
	});

	it("hides the toggle for screenshots", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				createElement(
					Share,
					createProps({
						data: {
							id: "video-id",
							name: "Test screenshot",
							orgId: "org-id",
							owner: { id: "owner-id", isPro: false },
							duration: null,
							metadata: null,
							createdAt: new Date(),
							isScreenshot: true,
							transcriptionStatus: null,
							source: { type: "desktopMP4" },
							orgSettings: null,
						} as unknown as ShareComponentProps["data"],
						initialView: "timeline",
						screenshotImageUrl: "https://example.com/shot.png",
					}),
				),
			);
		});

		expect(findButton(container, "Timeline")).toBeUndefined();
		expect(container.querySelector("[data-timeline-view]")).toBeNull();

		await act(async () => {
			root.unmount();
		});
	});
});
