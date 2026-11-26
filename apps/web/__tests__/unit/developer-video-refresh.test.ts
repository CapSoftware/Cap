// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
}));

const { RefreshUntilReady } = await import(
	"@/app/dev/_components/RefreshUntilReady"
);

let root: Root;
let visibility: DocumentVisibilityState;

const setVisibility = (state: DocumentVisibilityState) => {
	visibility = state;
	document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	mocks.refresh.mockReset();
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	root = createRoot(document.createElement("div"));
	await act(async () => root.render(createElement(RefreshUntilReady)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("developer video page refresh", () => {
	it("checks every three seconds at first", () => {
		expect(mocks.refresh).not.toHaveBeenCalled();

		vi.advanceTimersByTime(2_999);
		expect(mocks.refresh).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(57_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(20);
	});

	it("slows to ten seconds after a minute and to a minute after ten more", () => {
		vi.advanceTimersByTime(60_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(20);

		vi.advanceTimersByTime(9_999);
		expect(mocks.refresh).toHaveBeenCalledTimes(20);
		vi.advanceTimersByTime(1);
		expect(mocks.refresh).toHaveBeenCalledTimes(21);

		vi.advanceTimersByTime(590_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(80);

		vi.advanceTimersByTime(59_999);
		expect(mocks.refresh).toHaveBeenCalledTimes(80);
		vi.advanceTimersByTime(1);
		expect(mocks.refresh).toHaveBeenCalledTimes(81);
	});

	it("does not check while the tab is hidden and checks at once when it returns", () => {
		setVisibility("hidden");
		vi.advanceTimersByTime(30_000);
		expect(mocks.refresh).not.toHaveBeenCalled();

		setVisibility("visible");
		expect(mocks.refresh).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(3_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});

	it("stops when the player takes over", async () => {
		await act(async () => root.render(null));

		vi.advanceTimersByTime(60_000);
		setVisibility("visible");
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});
