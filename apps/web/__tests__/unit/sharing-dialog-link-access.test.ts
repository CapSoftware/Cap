// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";

const mocks = vi.hoisted(() => ({
	share: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/actions/caps/share", () => ({ shareCap: mocks.share }));
vi.mock("@/actions/videos/password", () => ({
	setVideoPassword: vi.fn(),
	removeVideoPassword: vi.fn(),
}));
vi.mock("@/actions/videos/viewer-invites", () => ({
	getVideoViewerGrants: async () => [],
	inviteVideoViewer: vi.fn(),
	revokeVideoViewer: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => undefined,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
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
	mocks.share.mockReset();
	mocks.share.mockResolvedValue({ success: true });
	mocks.toast.success.mockReset();
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

async function flushUpdates() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function render(props: {
	isPublic?: boolean;
	allowedEmailDomain?: string | null;
	allowLinkOverride?: boolean;
	linkOpenToAnyone?: boolean;
}) {
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
					...props,
				}),
			),
		);
	});
	await flushUpdates();
}

const button = (label: string) =>
	Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);

const text = () => document.body.textContent ?? "";

async function click(label: string) {
	const target = button(label);
	if (!target) throw new Error(`Missing ${label} button`);
	await act(async () => target.click());
	await flushUpdates();
}

describe("sharing dialog link access", () => {
	it("offers no choice in a restricted organization that has not allowed it", async () => {
		await render({ allowedEmailDomain: "company.com" });
		expect(text()).toContain("Restricted link access");
		expect(button("Matching emails only")).toBeUndefined();
		expect(button("Anyone with the link")).toBeUndefined();

		await click("Save");
		expect(mocks.share).toHaveBeenCalledOnce();
		expect(mocks.share.mock.calls[0]?.[0]).toEqual({
			capId: "video-id",
			spaceIds: [],
			public: true,
		});
	});

	it("offers no choice when the organization has no restriction", async () => {
		await render({ allowedEmailDomain: null, allowLinkOverride: true });
		expect(text()).toContain("Anyone on the internet with the link can view");
		expect(button("Matching emails only")).toBeUndefined();
	});

	it("hides the choice while the link is private", async () => {
		await render({
			isPublic: false,
			allowedEmailDomain: "company.com",
			allowLinkOverride: true,
		});
		expect(text()).toContain("Private");
		expect(button("Matching emails only")).toBeUndefined();
	});

	it("opens one link to anyone and saves only that change", async () => {
		await render({
			allowedEmailDomain: "company.com",
			allowLinkOverride: true,
		});
		expect(text()).toContain("Restricted link access");
		expect(button("Matching emails only")?.getAttribute("aria-pressed")).toBe(
			"true",
		);

		await click("Anyone with the link");
		expect(text()).not.toContain("Restricted link access");
		expect(text()).toContain("Anyone on the internet with the link can view");

		await click("Save");
		expect(mocks.share.mock.calls[0]?.[0]).toEqual({
			capId: "video-id",
			spaceIds: [],
			public: true,
			linkAccess: "anyone",
		});
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Anyone with the link can now view",
		);
	});

	it("restores the restriction on an opened link", async () => {
		await render({
			allowedEmailDomain: "company.com",
			allowLinkOverride: true,
			linkOpenToAnyone: true,
		});
		expect(text()).not.toContain("Restricted link access");

		await click("Matching emails only");
		await click("Save");
		expect(mocks.share.mock.calls[0]?.[0]).toMatchObject({
			linkAccess: "restricted",
		});
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Link limited to matching emails",
		);
	});

	it("sends no link access when an opened link is saved untouched", async () => {
		await render({
			allowedEmailDomain: "company.com",
			allowLinkOverride: true,
			linkOpenToAnyone: true,
		});
		await click("Save");
		expect(mocks.share.mock.calls[0]?.[0]).toEqual({
			capId: "video-id",
			spaceIds: [],
			public: true,
		});
	});
});
