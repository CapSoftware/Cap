// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
	fetch: vi.fn<typeof fetch>(),
	storage: { setItem: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));
vi.mock("sonner", () => ({
	toast: { error: mocks.error, success: mocks.success },
}));
vi.mock("hooks/useCurrency", () => ({
	useCurrency: () => ({ currency: "usd" }),
}));
vi.mock("@/app/Layout/StripeContext", () => ({
	useStripeContext: () => ({
		plans: { monthly: "price_monthly", yearly: "price_yearly" },
	}),
}));
vi.mock("@/lib/rive", () => ({
	Fit: {},
	Layout: class {},
	useRive: () => ({ RiveComponent: () => null }),
}));
vi.mock("@number-flow/react", () => ({
	default: ({ value }: { value: number }) => createElement("span", null, value),
}));
vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: PropsWithChildren) => children,
	motion: {
		div: ({ children, className }: PropsWithChildren<{ className?: string }>) =>
			createElement("div", { className }, children),
	},
}));

import { UpgradeModal } from "@/components/UpgradeModal";

describe("upgrade modal checkout", () => {
	let root: Root;
	let container: HTMLDivElement;
	let queryClient: QueryClient;
	const onCheckout = vi.fn<() => Promise<void>>();
	const onOpenChange = vi.fn();
	const button = () =>
		document.querySelector<HTMLButtonElement>(
			"button[aria-keyshortcuts=Space]",
		);
	const clickUpgrade = async () => {
		await act(async () => {
			button()?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};

	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("fetch", mocks.fetch);
		vi.stubGlobal("localStorage", mocks.storage);
		onCheckout.mockResolvedValue(undefined);
		window.history.replaceState(null, "", "/");
		queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(UpgradeModal, {
						open: true,
						onboarding: true,
						onCheckout,
						onOpenChange,
					}),
				),
			);
		});
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		queryClient.clear();
		container.remove();
		vi.unstubAllGlobals();
	});

	it.each([400, 500])(
		"keeps onboarding in place when checkout returns HTTP %s",
		async (status) => {
			mocks.fetch.mockResolvedValue(Response.json({ error: true }, { status }));
			await clickUpgrade();

			expect(onCheckout).not.toHaveBeenCalled();
			expect(onOpenChange).not.toHaveBeenCalled();
			expect(mocks.error).toHaveBeenCalledOnce();
			expect(button()?.disabled).toBe(false);
		},
	);

	it("preserves the checkout rate limit message without completing onboarding", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ error: true }, { status: 429 }),
		);
		await clickUpgrade();

		expect(onCheckout).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledWith(
			"Too many checkout attempts. Please wait a few minutes, then try again.",
		);
		expect(button()?.disabled).toBe(false);
	});

	it("reports a response with no checkout URL instead of completing onboarding", async () => {
		mocks.fetch.mockResolvedValue(Response.json({}));
		await clickUpgrade();

		expect(onCheckout).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledOnce();
	});

	it("reports a network failure and allows a retry", async () => {
		mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await clickUpgrade();

		expect(onCheckout).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledOnce();
		expect(button()?.disabled).toBe(false);

		mocks.fetch.mockResolvedValueOnce(Response.json({ url: "#checkout" }));
		await clickUpgrade();
		expect(onCheckout).toHaveBeenCalledOnce();
		expect(window.location.hash).toBe("#checkout");
	});

	it("reports a malformed response", async () => {
		mocks.fetch.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
		await clickUpgrade();

		expect(onCheckout).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledOnce();
	});

	it("keeps the existing-subscription success path", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ error: true, subscription: true }, { status: 400 }),
		);
		await clickUpgrade();

		expect(mocks.success).toHaveBeenCalledOnce();
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onCheckout).toHaveBeenCalledOnce();
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("preserves the selected plan when sign-in is required", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ error: true, auth: false }, { status: 401 }),
		);
		await clickUpgrade();

		expect(mocks.storage.setItem).toHaveBeenCalledWith(
			"pendingPriceId",
			"price_monthly",
		);
		expect(mocks.storage.setItem).toHaveBeenCalledWith("pendingQuantity", "1");
		expect(mocks.push).toHaveBeenCalledWith("/login?next=/dashboard");
		expect(onCheckout).not.toHaveBeenCalled();
		expect(mocks.error).not.toHaveBeenCalled();
	});

	it("finishes the onboarding callback before opening a successful checkout", async () => {
		mocks.fetch.mockResolvedValue(Response.json({ url: "#checkout" }));
		let finish: (() => void) | undefined;
		onCheckout.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		await clickUpgrade();
		expect(onCheckout).toHaveBeenCalledOnce();
		expect(window.location.hash).toBe("");

		await act(async () => finish?.());
		expect(window.location.hash).toBe("#checkout");
		expect(mocks.error).not.toHaveBeenCalled();
	});
});
