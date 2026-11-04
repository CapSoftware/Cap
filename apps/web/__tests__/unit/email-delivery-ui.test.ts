// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { InviteDialog } from "@/app/(org)/dashboard/settings/organization/components/InviteDialog";
import { VerifyOTPForm } from "@/app/(org)/verify-otp/form";

const mocks = vi.hoisted(() => ({
	invites: vi.fn<typeof sendOrganizationInvites>(),
	signIn: vi.fn(),
	refresh: vi.fn(),
	close: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/actions/organization/send-invites", () => ({
	sendOrganizationInvites: mocks.invites,
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { id: "org-1", name: "Team" } },
	}),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next-auth/react", () => ({ signIn: mocks.signIn }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@cap/utils", async () => await import("@cap/utils/helpers"));
vi.mock("@cap/ui", async () => ({
	...(await import("../../../../packages/ui/src/components/Button")),
	...(await import("../../../../packages/ui/src/components/Dialog")),
	...(await import("../../../../packages/ui/src/components/Select")),
	...(await import("../../../../packages/ui/src/components/Switch")),
	...(await import("../../../../packages/ui/src/components/input/Input")),
	...(await import("../../../../packages/ui/src/components/icons/LogoBadge")),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.invites.mockReset();
	mocks.signIn.mockResolvedValue({ ok: true });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	queryClient.clear();
	vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
	await act(async () => {
		root.render(
			createElement(QueryClientProvider, { client: queryClient }, element),
		);
	});
}

async function clickButton(label: string) {
	const button = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === label,
	);
	if (!button) throw new Error(`Missing button: ${label}`);
	await act(async () => {
		button.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("verification email delivery messages", () => {
	it.each([false, true])(
		"reports the correct resend destination when email configured is %s",
		async (emailDeliveryConfigured) => {
			await render(
				createElement(VerifyOTPForm, {
					email: "person@example.com",
					emailDeliveryConfigured,
				}),
			);
			expect(container.textContent).toContain(
				emailDeliveryConfigured
					? "We sent a 6-digit code"
					: "was printed to the server logs",
			);
			await clickButton("Didn't receive the code? Resend");
			expect(mocks.signIn).toHaveBeenCalledWith("email", {
				email: "person@example.com",
				redirect: false,
			});
			expect(mocks.toast.success).toHaveBeenCalledExactlyOnceWith(
				emailDeliveryConfigured
					? "A new code has been sent to your email!"
					: "A new code was printed to the server logs",
			);
		},
	);
});

describe("invitation email delivery messages", () => {
	it.each([false, true])(
		"does not claim skipped emails were sent when delivery failures are %s",
		async (hasFailures) => {
			mocks.invites.mockResolvedValue({
				success: true,
				failedEmails: hasFailures ? ["failed@example.com"] : [],
				skippedEmails: ["skipped@example.com"],
			});
			await render(
				createElement(InviteDialog, { isOpen: true, setIsOpen: mocks.close }),
			);
			const input = document.querySelector<HTMLInputElement>(
				"input[placeholder='name@company.com']",
			);
			if (!input) throw new Error("Missing invitation email input");
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(
					input,
					hasFailures
						? "skipped@example.com, failed@example.com"
						: "skipped@example.com",
				);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await clickButton("Send Invites");
			expect(mocks.invites).toHaveBeenCalledOnce();
			expect(mocks.toast.warning).toHaveBeenCalledWith(
				"Invites created but not emailed because email is not configured. Share the invite links with: skipped@example.com",
			);
			if (hasFailures) {
				expect(mocks.toast.warning).toHaveBeenCalledWith(
					"Invite email delivery failed for: failed@example.com",
				);
			}
			expect(mocks.toast.warning).not.toHaveBeenCalledWith(
				expect.stringContaining("Invites sent"),
			);
			expect(mocks.toast.success).not.toHaveBeenCalled();
			expect(mocks.close).toHaveBeenCalledWith(false);
			expect(mocks.refresh).toHaveBeenCalledOnce();
		},
	);
});
