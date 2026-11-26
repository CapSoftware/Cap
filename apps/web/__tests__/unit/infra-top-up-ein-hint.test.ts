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
			createElement(QueryClientProvider, {
				client: new QueryClient(),
				children: createElement(TopUp, { appId: "app-1", autoTopUpHref: null }),
			}),
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
			"US business? Add your EIN before you pay so it is on your invoice.",
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

	it("offers the EIN field only from the hint, not a second button", () => {
		const buttons = Array.from(container.querySelectorAll("button")).map(
			(button) => button.textContent,
		);
		expect(buttons.filter((text) => text?.includes("EIN"))).toEqual([
			"Add your EIN",
		]);
	});

	it("lets the buyer clear the EIN and still pay", () => {
		const link = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Add your EIN",
		);
		act(() => link?.click());
		const input = einInput();
		if (!input) throw new Error("no EIN field");
		const type = (value: string) => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			act(() => {
				setter?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
		};
		const submit = () =>
			container.querySelector<HTMLButtonElement>('button[type="submit"]');

		type("12-34");
		expect(submit()?.disabled).toBe(true);
		type("");
		expect(submit()?.disabled).toBe(false);
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
});
