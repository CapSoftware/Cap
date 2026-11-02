// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatManagementCard } from "@/app/(org)/dashboard/settings/organization/components/SeatManagementCard";

const mocks = vi.hoisted(() => ({
	organizationId: "org-a",
	seats: 1,
	refresh: vi.fn(),
	preview: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: true } }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: {
			organization: { id: mocks.organizationId, ownerId: "owner" },
			inviteQuota: mocks.seats,
			members: [],
		},
	}),
}));
vi.mock("@/actions/organization/update-seat-quantity", () => ({
	previewSeatChange: mocks.preview,
	updateSeatQuantity: mocks.update,
}));
vi.mock("@/actions/organization/signed-baa", () => ({
	getSignedBaaStatus: async () => null,
}));
vi.mock("@number-flow/react", () => ({
	default: ({ value }: { value: number }) =>
		createElement("span", { "data-quantity": true }, value),
}));
vi.mock("@cap/ui", () => {
	const container = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return {
		Card: container,
		CardDescription: container,
		CardHeader: container,
		CardTitle: container,
		Button: ({ children, disabled, onClick }: ComponentProps<"button">) =>
			createElement("button", { disabled, onClick, type: "button" }, children),
	};
});
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: ({
		open,
		onConfirm,
	}: {
		open: boolean;
		onConfirm: () => void;
	}) =>
		open
			? createElement(
					"button",
					{ onClick: onConfirm, type: "button" },
					"Cancel subscription",
				)
			: null,
}));

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

const render = async () => {
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(SeatManagementCard),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
	});
};
const quantity = () =>
	Number(host.querySelector("[data-quantity]")?.textContent);
const button = (text: string) =>
	Array.from(host.querySelectorAll("button")).find(
		(node) => node.textContent === text,
	);
const click = async (target: HTMLButtonElement | undefined) => {
	if (!target) throw new Error("Expected a seat control");
	await act(async () => {
		target.click();
		await vi.advanceTimersByTimeAsync(0);
	});
};
const increase = () => click(host.querySelectorAll("button")[1]);
const decrease = () => click(host.querySelectorAll("button")[0]);
const settleDebounce = async () => {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.organizationId = "org-a";
	mocks.seats = 1;
	mocks.refresh.mockClear();
	mocks.preview
		.mockReset()
		.mockResolvedValue({ proratedAmount: 0, currency: "usd" });
	mocks.update
		.mockReset()
		.mockResolvedValue({ newQuantity: 2, cancelAtPeriodEnd: false });
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	queryClient.clear();
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("seat form organization ownership", () => {
	it("discards a pending seat edit when switching to an organization with the same seat count", async () => {
		await render();
		await increase();
		expect(quantity()).toBe(2);
		mocks.organizationId = "org-b";
		await render();
		await settleDebounce();
		expect(quantity()).toBe(1);
		expect(button("Confirm")).toBeUndefined();
		expect(mocks.preview).not.toHaveBeenCalledWith("org-b", 2);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("closes the previous organization's cancellation confirmation on switch", async () => {
		await render();
		await decrease();
		await settleDebounce();
		await click(button("Confirm"));
		expect(button("Cancel subscription")).toBeDefined();
		mocks.organizationId = "org-b";
		await render();
		expect(button("Cancel subscription")).toBeUndefined();
		expect(quantity()).toBe(1);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("keeps new edits and cache ownership when an old cancellation finishes", async () => {
		const pending = Promise.withResolvers<{
			newQuantity: number;
			cancelAtPeriodEnd: boolean;
		}>();
		mocks.update.mockReturnValueOnce(pending.promise);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		await render();
		await decrease();
		await settleDebounce();
		await click(button("Confirm"));
		await click(button("Cancel subscription"));
		expect(mocks.update).toHaveBeenCalledWith("org-a", 0);
		mocks.organizationId = "org-b";
		await render();
		while (quantity() < 2) await increase();
		await settleDebounce();
		await act(async () => {
			pending.resolve({ newQuantity: 0, cancelAtPeriodEnd: true });
			await pending.promise;
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(quantity()).toBe(2);
		expect(button("Confirm")?.disabled).toBe(false);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["subscription-details", "org-a"],
		});
		expect(invalidate).not.toHaveBeenCalledWith({
			queryKey: ["subscription-details", "org-b"],
		});
	});

	it("preserves an unsaved edit on ordinary rerenders within one organization", async () => {
		await render();
		await increase();
		await render();
		await settleDebounce();
		expect(quantity()).toBe(2);
		expect(button("Confirm")?.disabled).toBe(false);
	});

	it("continues to synchronize changed seat totals within one organization", async () => {
		await render();
		await increase();
		mocks.seats = 5;
		await render();
		await settleDebounce();
		expect(quantity()).toBe(5);
		expect(button("Confirm")).toBeUndefined();
	});

	it("submits the confirmed quantity for the current organization", async () => {
		await render();
		await increase();
		await settleDebounce();
		await click(button("Confirm"));
		expect(mocks.update).toHaveBeenCalledWith("org-a", 2);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
});
