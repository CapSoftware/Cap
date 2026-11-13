// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TopUp } from "@/app/(infra)/dashboard/infra/[appId]/billing/top-up";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client: new QueryClient() },
				createElement(TopUp, { appId: "app-1" }),
			),
		),
	);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const einInput = () =>
	container.querySelector<HTMLInputElement>('input[placeholder^="US EIN"]');

describe("US EIN hint on the top-up form", () => {
	it("tells a US business to add its EIN before paying", () => {
		expect(container.textContent).toContain(
			"US business? Add your EIN before you pay so it is on your receipt.",
		);
		expect(einInput()).toBeNull();
	});

	it("opens the EIN field from the hint and then steps aside", () => {
		const link = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Add your EIN",
		);
		expect(link).toBeDefined();

		act(() => link?.click());

		expect(einInput()).not.toBeNull();
		expect(container.textContent).not.toContain("US business?");
	});
});
