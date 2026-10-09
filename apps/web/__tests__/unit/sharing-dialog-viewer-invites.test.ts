// @vitest-environment jsdom

import { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { inviteVideoViewer } from "@/actions/videos/viewer-invites";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";

const mocks = vi.hoisted(() => ({
	invite: vi.fn<typeof inviteVideoViewer>(),
	grants: vi.fn(),
	refresh: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/actions/caps/share", () => ({ shareCap: vi.fn() }));
vi.mock("@/actions/videos/password", () => ({
	setVideoPassword: vi.fn(),
	removeVideoPassword: vi.fn(),
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
	mocks.invite.mockReset();
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

async function render() {
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
					isPublic: false,
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

function emailInput() {
	const input = document.querySelector<HTMLInputElement>(
		"input[placeholder='viewer@example.com']",
	);
	if (!input) throw new Error("Missing viewer email input");
	return input;
}

function inviteButton() {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === "Invite",
	);
	if (!button) throw new Error("Missing Invite button");
	return button;
}

async function enterEmail(email: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("Missing input setter");
	await act(async () => {
		setter.call(emailInput(), email);
		emailInput().dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function submit() {
	await act(async () => inviteButton().click());
	await flushUpdates();
}

function expectNoSuccessEffects() {
	expect(mocks.grants).toHaveBeenCalledOnce();
	expect(mocks.refresh).not.toHaveBeenCalled();
	expect(mocks.toast.success).not.toHaveBeenCalled();
	expect(mocks.toast.info).not.toHaveBeenCalled();
	expect(mocks.toast.warning).not.toHaveBeenCalled();
}

describe("sharing dialog viewer invitations", () => {
	it("preserves invalid input on repeated submits and allows correction", async () => {
		mocks.invite.mockResolvedValue({
			success: false,
			error: "Enter a valid email address",
		});
		await render();
		await enterEmail("invalid");
		for (let attempt = 1; attempt <= 2; attempt++) {
			await submit();
			expect(mocks.invite).toHaveBeenCalledTimes(attempt);
			expect(mocks.invite).toHaveBeenLastCalledWith("video-id", "invalid");
			expect(mocks.toast.error).toHaveBeenLastCalledWith(
				"Enter a valid email address",
			);
			expect(emailInput().value).toBe("invalid");
			expect(inviteButton().disabled).toBe(false);
			expectNoSuccessEffects();
		}

		mocks.invite.mockResolvedValue({
			success: true,
			alreadyAdded: false,
			emailSent: true,
		});
		await enterEmail("viewer@example.com");
		await submit();
		expect(mocks.invite).toHaveBeenLastCalledWith(
			"video-id",
			"viewer@example.com",
		);
		expect(emailInput().value).toBe("");
		expect(mocks.grants).toHaveBeenCalledTimes(2);
		expect(mocks.refresh).toHaveBeenCalledOnce();
		expect(mocks.toast.success).toHaveBeenCalledWith("Viewer invited");
	});

	it("blocks repeat clicks and edits while an invite is pending", async () => {
		let finish: (
			result: Awaited<ReturnType<typeof inviteVideoViewer>>,
		) => void = () => {
			throw new Error("Invite has not started");
		};
		mocks.invite.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await enterEmail("viewer@example.com");
		const button = inviteButton();
		await submit();
		expect(button.disabled).toBe(true);
		expect(emailInput().disabled).toBe(true);
		await act(async () => button.click());
		expect(mocks.invite).toHaveBeenCalledOnce();
		await act(async () =>
			finish({ success: true, alreadyAdded: false, emailSent: true }),
		);
		await flushUpdates();
		expect(emailInput().disabled).toBe(false);
		expect(emailInput().value).toBe("");
		expect(mocks.toast.success).toHaveBeenCalledOnce();
	});

	it.each([
		{
			result: { success: true, alreadyAdded: true, emailSent: false },
			toast: "info",
			message: "This viewer already has access",
		},
		{
			result: { success: true, alreadyAdded: false, emailSent: false },
			toast: "warning",
			message:
				"Access added, but the invitation email was not sent. Copy the link to share it.",
		},
	] as const)(
		"preserves $toast feedback after granting access",
		async ({ result, toast, message }) => {
			mocks.invite.mockResolvedValue(result);
			await render();
			await enterEmail("viewer@example.com");
			await submit();
			expect(emailInput().value).toBe("");
			expect(mocks.grants).toHaveBeenCalledTimes(2);
			expect(mocks.refresh).toHaveBeenCalledOnce();
			expect(mocks.toast[toast]).toHaveBeenCalledWith(message);
			expect(mocks.toast.error).not.toHaveBeenCalled();
		},
	);

	it("retains input and error feedback after an unexpected action failure", async () => {
		mocks.invite.mockRejectedValue(new Error("Unable to invite viewer"));
		await render();
		await enterEmail("viewer@example.com");
		await submit();
		expect(emailInput().value).toBe("viewer@example.com");
		expect(mocks.toast.error).toHaveBeenCalledWith("Unable to invite viewer");
		expectNoSuccessEffects();
	});
});
