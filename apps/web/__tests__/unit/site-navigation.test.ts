// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const { DesktopNavLinks } = await import("@/app/(site)/DesktopNavLinks");
const { default: MobileMenu } = await import("@/components/ui/MobileMenu");

const mounted: Array<() => void> = [];

const mount = (element: ReturnType<typeof createElement>) => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(element));
	mounted.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
};

afterEach(() => {
	for (const unmount of mounted.splice(0)) unmount();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const topLevelLabels = (nav: Element) =>
	Array.from(nav.querySelectorAll(":scope > ul > li")).map((item) =>
		item.querySelector(":scope > a, :scope > button")?.textContent?.trim(),
	);

describe("site navigation", () => {
	it("puts Infra after Agents in the desktop header with the same link styles", () => {
		const container = mount(createElement(DesktopNavLinks));
		const nav = container.querySelector('nav[aria-label="Main"]');
		if (!nav) throw new Error("desktop nav missing");

		expect(topLevelLabels(nav)).toEqual([
			"Product",
			"Agents",
			"Infra",
			"Testimonials",
			"Help",
			"About",
			"Blog",
			"Pricing",
		]);

		const infra = nav.querySelector(':scope > ul > li > a[href="/infra"]');
		const agents = nav.querySelector(':scope > ul > li > a[href="/agents"]');
		expect(infra?.textContent).toBe("Infra");
		expect(infra?.className).toBe(agents?.className);
		expect(infra?.parentElement?.className).toBe(
			agents?.parentElement?.className,
		);
	});

	it("puts Infra after Agents in the phone menu with the same link styles", () => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		const container = mount(createElement(MobileMenu));
		const trigger = container.querySelector('button[aria-label="Open menu"]');
		if (!(trigger instanceof HTMLButtonElement)) {
			throw new Error("menu trigger missing");
		}
		act(() => trigger.click());

		const nav = document.body.querySelector('nav[aria-label="Primary"]');
		if (!nav) throw new Error("phone nav missing");
		const links = Array.from(nav.querySelectorAll("a"));

		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"/pricing",
			"/download",
			"/agents",
			"/infra",
			"/migrate-from-loom",
			"/blog",
			"/changelog",
			"/about",
			"/testimonials",
			"/faq",
		]);

		const infra = links.find((link) => link.getAttribute("href") === "/infra");
		const agents = links.find(
			(link) => link.getAttribute("href") === "/agents",
		);
		expect(infra?.textContent).toBe("Infra");
		expect(infra?.className).toBe(agents?.className);
		expect(infra?.parentElement?.className).toBe(
			agents?.parentElement?.className,
		);
	});
});
