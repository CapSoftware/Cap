// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/" as string | null }));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/actions/messenger", () => ({
	fetchMessengerConversation: vi.fn(async () => null),
	fetchMessengerConversations: vi.fn(async () => []),
	createMessengerConversation: vi.fn(async () => null),
	sendMessengerUserMessage: vi.fn(),
}));
vi.mock("next/image", () => ({
	default: ({ src, alt }: { src: string; alt: string }) =>
		createElement("img", { src, alt }),
}));

import { MessengerWidget } from "@/app/Layout/MessengerWidget";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	state.pathname = "/";
});

const render = (pathname: string | null) => {
	state.pathname = pathname;
	act(() => root.render(createElement(MessengerWidget)));
	const launcher = container.querySelector("button[aria-label]");
	if (!launcher) throw new Error("launcher not rendered");
	return launcher;
};

const open = async (launcher: Element) => {
	await act(async () => {
		(launcher as HTMLButtonElement).click();
	});
	return container.querySelector(".cap-messenger-panel");
};

describe("messenger launcher above the dashboard's mobile tab bar", () => {
	it.each([
		"/dashboard",
		"/dashboard/caps",
		"/dashboard/settings/organization",
	])(
		"lifts the launcher and the panel below the lg breakpoint on %s",
		async (pathname) => {
			const launcher = render(pathname);
			expect(launcher.className).toContain("max-lg:bottom-[84px]");
			expect(launcher.className).toContain("bottom-5");

			const panel = await open(launcher);
			expect(panel?.classList.contains("cap-messenger-panel-dashboard")).toBe(
				true,
			);
		},
	);

	it.each(["/", "/pricing", "/s/abc123", "/dashboardish", null])(
		"leaves the launcher and panel where they were on %s",
		async (pathname) => {
			const launcher = render(pathname);
			expect(launcher.className).not.toContain("max-lg:");
			expect(launcher.className).toContain("bottom-5");

			const panel = await open(launcher);
			expect(panel?.classList.contains("cap-messenger-panel-dashboard")).toBe(
				false,
			);
		},
	);

	const widgetCss = () =>
		(
			render("/dashboard/caps").parentElement?.querySelector("style")
				?.textContent ?? ""
		).replace(/\s+/g, " ");

	it("lifts the panel by the tab bar's 64 px below the lg breakpoint", () => {
		const css = widgetCss();
		const block = css.match(
			/@media \(max-width: 1023\.98px\) \{ \.cap-messenger-panel-dashboard \{ ([^}]*) \} \}/,
		);
		expect(block?.[1]).toContain("bottom: 152px;");
		expect(block?.[1]).toContain("height: min(760px, calc(100dvh - 172px));");
		expect(css).toContain("bottom: 88px;");
		expect(css).toContain("height: min(760px, calc(100dvh - 108px));");
	});

	it("keeps the full screen panel on phones above the dashboard rule", () => {
		const css = widgetCss();
		const dashboardRule = css.indexOf(".cap-messenger-panel-dashboard");
		const phoneRule = css.indexOf("@media (max-width: 480px)");
		expect(dashboardRule).toBeGreaterThan(-1);
		expect(phoneRule).toBeGreaterThan(dashboardRule);
		expect(css.slice(phoneRule)).toMatch(
			/\.cap-messenger-panel \{ width: 100vw; height: 100dvh; right: 0; bottom: 0;/,
		);
	});
});
