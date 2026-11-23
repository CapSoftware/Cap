// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverPrefetchLink } from "@/components/hover-prefetch-link";

const mocks = vi.hoisted(() => ({
	prefetch: vi.fn(),
	linkProps: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ prefetch: mocks.prefetch }),
}));

vi.mock("next/link", async () => {
	const { createElement, forwardRef } = await import("react");
	return {
		default: forwardRef<HTMLAnchorElement, Record<string, unknown>>(
			function MockLink({ prefetch, ...props }, ref) {
				mocks.linkProps.push({ prefetch });
				return createElement("a", { ...props, ref });
			},
		),
	};
});

const env = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("HoverPrefetchLink", () => {
	let container: HTMLDivElement;
	beforeEach(() => {
		env.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		mocks.prefetch.mockReset();
		mocks.linkProps.length = 0;
	});
	afterEach(() => container.remove());

	it("doesn't prefetch on render, then prefetches once on hover or focus", async () => {
		const onPointerEnter = vi.fn();
		const root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(
					HoverPrefetchLink,
					{ href: "/dashboard/caps", onPointerEnter },
					"Dashboard",
				),
			);
		});
		expect(mocks.linkProps.at(-1)?.prefetch).toBe(false);
		expect(mocks.prefetch).not.toHaveBeenCalled();

		const link = container.querySelector("a");
		if (!link) throw new Error("link missing");
		await act(async () => {
			// jsdom has no PointerEvent; React derives pointerenter from pointerover.
			link.dispatchEvent(
				new MouseEvent("pointerover", {
					bubbles: true,
					relatedTarget: document.body,
				}),
			);
		});
		await act(async () => {
			link.focus();
		});

		expect(mocks.prefetch).toHaveBeenCalledTimes(1);
		expect(mocks.prefetch).toHaveBeenCalledWith("/dashboard/caps");
		expect(onPointerEnter).toHaveBeenCalled();
		await act(async () => root.unmount());
	});
});
