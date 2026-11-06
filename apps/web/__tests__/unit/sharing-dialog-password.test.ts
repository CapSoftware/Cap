// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { shareCap } from "@/actions/caps/share";
import type {
	removeVideoPassword,
	setVideoPassword,
} from "@/actions/videos/password";
import type { inviteVideoViewer } from "@/actions/videos/viewer-invites";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";

const mocks = vi.hoisted(() => ({
	invite: vi.fn<typeof inviteVideoViewer>(),
	share: vi.fn<typeof shareCap>(),
	setPassword: vi.fn<typeof setVideoPassword>(),
	removePassword: vi.fn<typeof removeVideoPassword>(),
	close: vi.fn(),
	sharingUpdated: vi.fn(),
	grants: vi.fn(),
	refresh: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/actions/caps/share", () => ({ shareCap: mocks.share }));
vi.mock("@/actions/videos/password", () => ({
	setVideoPassword: mocks.setPassword,
	removeVideoPassword: mocks.removePassword,
}));
vi.mock("@/actions/videos/viewer-invites", () => ({
	getVideoViewerGrants: mocks.grants,
	inviteVideoViewer: mocks.invite,
	revokeVideoViewer: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => undefined,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
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
	mocks.share.mockReset().mockResolvedValue({ success: true });
	mocks.setPassword
		.mockReset()
		.mockResolvedValue({ success: true, value: "Password updated" });
	mocks.removePassword
		.mockReset()
		.mockResolvedValue({ success: true, value: "Password removed" });
	mocks.grants.mockResolvedValue([]);
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

async function render(hasPassword = false) {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(SharingDialog, {
					isOpen: true,
					onClose: mocks.close,
					capId: Video.VideoId.make("video-id"),
					capName: "Test video",
					sharedSpaces: [],
					onSharingUpdated: mocks.sharingUpdated,
					isPublic: hasPassword,
					hasPassword,
				}),
			),
		);
	});
	await flushUpdates();
	expect(mocks.grants).toHaveBeenCalledOnce();
}

async function flushUpdates() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function button(label: string) {
	const element = [...document.querySelectorAll("button")].find(
		(element) => element.textContent === label,
	);
	if (!element) throw new Error(`Missing ${label} button`);
	return element;
}

async function toggle(index: number) {
	const control =
		document.querySelectorAll<HTMLButtonElement>("[role=switch]")[index];
	if (!control) throw new Error("Missing sharing toggle");
	await act(async () => control.click());
}

async function enterPassword() {
	const input = document.querySelector<HTMLInputElement>(
		"input[type=password]",
	);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!input || !setter) throw new Error("Missing password input");
	await act(async () => {
		setter.call(input, "secret");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function save() {
	await act(async () => button("Save").click());
	await flushUpdates();
}

describe("sharing dialog password changes", () => {
	it("keeps a private Cap private until its new password has been saved", async () => {
		const pending =
			Promise.withResolvers<Awaited<ReturnType<typeof setVideoPassword>>>();
		mocks.setPassword.mockReturnValue(pending.promise);
		await render();
		await toggle(0);
		await toggle(1);
		await enterPassword();
		await save();
		try {
			expect(mocks.setPassword).toHaveBeenCalledWith("video-id", "secret");
			expect(mocks.share).not.toHaveBeenCalled();
			expect(mocks.close).not.toHaveBeenCalled();
		} finally {
			await act(async () =>
				pending.resolve({ success: true, value: "Password updated" }),
			);
			await flushUpdates();
		}
		expect(mocks.share).toHaveBeenCalledWith({
			capId: "video-id",
			spaceIds: [],
			public: true,
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it.each(["returned error", "rejected request"])(
		"does not publish a Cap after a password save fails with a %s",
		async (failure) => {
			if (failure === "returned error") {
				mocks.setPassword.mockResolvedValueOnce({
					success: false,
					error: "Failed to save password",
				});
			} else {
				mocks.setPassword.mockRejectedValueOnce(new Error("Network failure"));
			}
			await render();
			await toggle(0);
			await toggle(1);
			await enterPassword();
			await save();
			expect(mocks.share).not.toHaveBeenCalled();
			expect(mocks.close).not.toHaveBeenCalled();
			expect(mocks.sharingUpdated).not.toHaveBeenCalled();
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Failed to update sharing settings",
			);
			expect(
				document.querySelector<HTMLInputElement>("input[type=password]")?.value,
			).toBe("secret");
			await save();
			expect(mocks.setPassword).toHaveBeenCalledTimes(2);
			expect(mocks.share).toHaveBeenCalledOnce();
			expect(mocks.close).toHaveBeenCalledOnce();
		},
	);

	it("keeps the saved password when the subsequent sharing update fails", async () => {
		mocks.share.mockResolvedValueOnce({
			success: false,
			error: "Failed to share",
		});
		await render();
		await toggle(0);
		await toggle(1);
		await enterPassword();
		await save();
		expect(mocks.setPassword).toHaveBeenCalledWith("video-id", "secret");
		expect(mocks.share).toHaveBeenCalledOnce();
		expect(mocks.removePassword).not.toHaveBeenCalled();
		expect(mocks.close).not.toHaveBeenCalled();
		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Failed to update sharing settings",
		);
	});

	it("still publishes a Cap when no password was requested", async () => {
		await render();
		await toggle(0);
		await save();
		expect(mocks.share).toHaveBeenCalledWith({
			capId: "video-id",
			spaceIds: [],
			public: true,
		});
		expect(mocks.setPassword).not.toHaveBeenCalled();
		expect(mocks.removePassword).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("keeps the password until making a public Cap private succeeds", async () => {
		mocks.share.mockResolvedValueOnce({
			success: false,
			error: "Failed to share",
		});
		await render(true);
		await toggle(0);
		await toggle(1);
		await save();
		expect(mocks.removePassword).not.toHaveBeenCalled();
		expect(mocks.close).not.toHaveBeenCalled();
		await save();
		expect(mocks.share).toHaveBeenLastCalledWith({
			capId: "video-id",
			spaceIds: [],
			public: false,
		});
		expect(mocks.removePassword).toHaveBeenCalledWith("video-id");
		expect(mocks.close).toHaveBeenCalledOnce();
	});
});
