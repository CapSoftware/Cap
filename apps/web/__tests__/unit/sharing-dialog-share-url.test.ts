// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";

const mocks = vi.hoisted(() => ({
	env: {
		buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
		NODE_ENV: "production",
	},
	organization: null as {
		customDomain: string | null;
		domainVerified: Date | null;
	} | null,
	writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@cap/env", () => mocks.env);
vi.mock("@/actions/caps/share", () => ({ shareCap: vi.fn() }));
vi.mock("@/actions/videos/password", () => ({
	setVideoPassword: vi.fn(),
	removeVideoPassword: vi.fn(),
}));
vi.mock("@/actions/videos/viewer-invites", () => ({
	getVideoViewerGrants: vi.fn(async () => []),
	inviteVideoViewer: vi.fn(),
	revokeVideoViewer: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: mocks.organization
			? { organization: mocks.organization }
			: null,
	}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({ webUrl: "https://cap.example" }),
}));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/Switch")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
	mocks.env.NODE_ENV = "production";
	mocks.organization = null;
	mocks.writeText.mockReset();
	mocks.writeText.mockResolvedValue();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: mocks.writeText },
	});
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

async function copiedLink(shareUrl?: string) {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(SharingDialog, {
					isOpen: true,
					onClose: vi.fn(),
					capId: Video.VideoId.make("video-id"),
					capName: "Test video",
					sharedSpaces: [],
					onSharingUpdated: vi.fn(),
					isPublic: true,
					shareUrl,
				}),
			),
		);
	});
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === "Copy link",
	);
	if (!button) throw new Error("Missing Copy link button");
	await act(async () => button.click());
	expect(mocks.writeText).toHaveBeenCalledOnce();
	return mocks.writeText.mock.calls[0]?.[0];
}

describe("sharing dialog share link", () => {
	it("copies the verified custom domain link", async () => {
		mocks.organization = {
			customDomain: "videos.team.test",
			domainVerified: new Date(),
		};
		expect(await copiedLink()).toBe("https://videos.team.test/s/video-id");
	});

	it("keeps the default link while the custom domain is unverified", async () => {
		mocks.organization = {
			customDomain: "videos.team.test",
			domainVerified: null,
		};
		expect(await copiedLink()).toBe("https://cap.example/s/video-id");
	});

	it("keeps the default link without a custom domain", async () => {
		expect(await copiedLink()).toBe("https://cap.example/s/video-id");
	});

	it("keeps the default link on self-hosted and development builds", async () => {
		mocks.organization = {
			customDomain: "videos.team.test",
			domainVerified: new Date(),
		};
		mocks.env.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		expect(await copiedLink()).toBe("https://cap.example/s/video-id");

		mocks.writeText.mockClear();
		mocks.env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		mocks.env.NODE_ENV = "development";
		expect(await copiedLink()).toBe("https://cap.example/s/video-id");
	});

	it("copies the link the share page resolved for the video", async () => {
		expect(await copiedLink("https://videos.team.test/s/video-id")).toBe(
			"https://videos.team.test/s/video-id",
		);
	});
});
