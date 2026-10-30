// @vitest-environment jsdom

import Cookies from "js-cookie";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SonnerToaster } from "@/components/SonnerToastProvider";

vi.mock("sonner", () => ({
	Toaster: ({ theme }: { theme: string }) =>
		createElement("div", { "data-testid": "toaster", "data-theme": theme }),
}));

let container: HTMLDivElement;
let root: Root;

const currentTheme = () =>
	container.querySelector("[data-testid=toaster]")?.getAttribute("data-theme");

const mount = async (strict = false) => {
	await act(async () => {
		root.render(
			strict
				? createElement(StrictMode, null, createElement(SonnerToaster))
				: createElement(SonnerToaster),
		);
	});
};

const changeTheme = async (className: string) => {
	await act(async () => {
		document.body.className = className;
	});
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	document.body.className = "light";
	Cookies.set("theme", "light");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.className = "";
	Cookies.remove("theme");
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("SonnerToaster theme", () => {
	it.each(["light", "dark", "system"])(
		"reads the initial %s theme from the page",
		async (theme) => {
			Cookies.set("theme", theme);
			document.body.className = theme;
			await mount();
			expect(currentTheme()).toBe(theme);
		},
	);

	it("uses the visible page theme when it differs from the saved cookie", async () => {
		document.body.className = "dark";
		await mount();
		expect(currentTheme()).toBe("dark");
	});

	it("tracks non-persistent theme changes and restores the light page on navigation", async () => {
		await mount();
		await changeTheme("dark");
		expect(currentTheme()).toBe("dark");
		await changeTheme("light");
		expect(currentTheme()).toBe("light");
	});

	it("uses light on public pages with a saved dark preference", async () => {
		Cookies.set("theme", "dark");
		document.body.className = "";
		await mount();
		expect(currentTheme()).toBe("light");
	});

	it("recognizes theme tokens alongside unrelated body classes", async () => {
		await mount();
		await changeTheme("font-custom dark scroll-locked");
		expect(currentTheme()).toBe("dark");
		await changeTheme("font-custom light scroll-locked");
		expect(currentTheme()).toBe("light");
	});

	it("does no cookie reads or timer polling during ten idle seconds", async () => {
		vi.useFakeTimers();
		await mount();
		const cookieRead = vi.spyOn(document, "cookie", "get");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(cookieRead).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("disconnects its observer on unmount and still updates after a StrictMode remount", async () => {
		const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
		await mount(true);
		expect(disconnect).toHaveBeenCalledTimes(1);
		await changeTheme("dark");
		expect(currentTheme()).toBe("dark");
		await act(async () => root.unmount());
		expect(disconnect).toHaveBeenCalledTimes(2);
		root = createRoot(container);
		await mount();
		await changeTheme("light");
		expect(currentTheme()).toBe("light");
	});
});
