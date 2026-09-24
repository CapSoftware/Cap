// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UploadProgress } from "@/app/s/[videoId]/_components/upload-progress";

const mocks = vi.hoisted(() => ({
	progress: null as UploadProgress | null,
	router: { refresh: vi.fn() },
	retry: vi.fn(async () => ({ success: true, status: "started" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: mocks.retry,
}));
vi.mock("@/app/s/[videoId]/_components/ProgressCircle", () => ({
	useUploadProgress: () => mocks.progress,
}));

import { EditProcessing } from "@/app/s/[videoId]/edit/EditProcessing";

let root: Root;
let container: HTMLDivElement;
const videoId = "video" as Video.VideoId;
const render = async () => {
	await act(async () =>
		root.render(createElement(EditProcessing, { videoId })),
	);
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	mocks.progress = { status: "fetching" };
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

test("waits through polling and refreshes once when processing completes", async () => {
	await render();
	expect(mocks.router.refresh).not.toHaveBeenCalled();
	mocks.progress = {
		status: "processing",
		progress: 40,
		message: null,
		lastUpdated: new Date(),
	};
	await render();
	expect(container.querySelector("progress")?.value).toBe(40);
	expect(mocks.router.refresh).not.toHaveBeenCalled();
	mocks.progress = null;
	await render();
	await render();
	expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
});

test("retries a stalled recording with retained source media", async () => {
	mocks.progress = {
		status: "error",
		lastUpdated: new Date(),
		errorMessage: "stalled",
		hasRawFallback: true,
	};
	await render();
	expect(container.textContent).toContain("needs attention");
	await act(async () => container.querySelector("button")?.click());
	expect(mocks.retry).toHaveBeenCalledWith({ videoId });
	expect(mocks.router.refresh).toHaveBeenCalledOnce();
});

test("reports retry failures without navigating away", async () => {
	mocks.progress = {
		status: "error",
		lastUpdated: new Date(),
		errorMessage: "stalled",
		hasRawFallback: true,
	};
	mocks.retry.mockRejectedValueOnce(new Error("Retry unavailable"));
	await render();
	await act(async () => container.querySelector("button")?.click());
	expect(container.querySelector("[role='alert']")?.textContent).toBe(
		"Retry unavailable",
	);
	expect(mocks.router.refresh).not.toHaveBeenCalled();
});

test("does not offer processing retries when no raw source remains", async () => {
	mocks.progress = {
		status: "error",
		lastUpdated: new Date(),
		errorMessage: "source missing",
		hasRawFallback: false,
	};
	await render();
	expect(container.querySelector("button")).toBeNull();
	expect(container.querySelector("a")?.getAttribute("href")).toBe("/s/video");
});
