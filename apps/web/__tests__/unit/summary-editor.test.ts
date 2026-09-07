// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import { Summary } from "@/app/s/[videoId]/_components/tabs/Summary";
import { SummaryEditor } from "@/app/s/[videoId]/_components/tabs/SummaryEditor";

vi.mock("@/actions/videos/edit-ai-content", () => ({ editAiContent: vi.fn() }));
vi.mock("@cap/ui", async () => ({
	Button: (await import("../../../../packages/ui/src/components/Button"))
		.Button,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const initialContent = {
	summary: "Original **summary**",
	chapters: [
		{ title: "Introduction", start: 0 },
		{ title: "Next steps", start: 60 },
	],
};
const videoId = "video-id" as Video.VideoId;
const onClose = vi.fn();

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(["videoStatus", videoId], {
		...initialContent,
		aiGenerationStatus: "COMPLETE",
		name: "Video name",
	});
	vi.mocked(editAiContent).mockReset();
});
afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	container.remove();
	vi.unstubAllGlobals();
});
const render = async (
	element: ReactNode = createElement(SummaryEditor, {
		videoId,
		initialContent,
		duration: 120,
		onClose,
	}),
) => {
	await act(async () =>
		root.render(
			createElement(QueryClientProvider, { client: queryClient }, element),
		),
	);
};
const button = (text: string) => {
	const found = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Button missing: ${text}`);
	return found;
};
const change = async (
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) => {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const summary = () => {
	const element = container.querySelector("textarea");
	if (!element) throw new Error("Summary editor missing");
	return element;
};

describe("summary and chapter editor", () => {
	it("starts clean with MySQL chapter key ordering", async () => {
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent: {
					...initialContent,
					chapters: [{ start: 0, title: "Intro" }],
				},
				duration: 120,
				onClose,
			}),
		);
		expect(button("Save changes").disabled).toBe(true);
	});
	it("focuses the summary and cancels without a write", async () => {
		await render();
		expect(document.activeElement).toBe(summary());
		expect(button("Save changes").disabled).toBe(true);
		await change(summary(), "Draft");
		await act(async () => button("Cancel").click());
		expect(onClose).toHaveBeenCalledWith(false);
		expect(editAiContent).not.toHaveBeenCalled();
	});
	it("saves once, updates the shared cache, and preserves unrelated status", async () => {
		let finish: (value: Awaited<ReturnType<typeof editAiContent>>) => void =
			() => {};
		vi.mocked(editAiContent).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await render();
		await change(summary(), "Edited");
		await act(async () => {
			button("Save changes").click();
		});
		expect(button("Saving…").disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(true);
		expect(summary().disabled).toBe(true);
		await act(async () => {
			finish({ success: true, data: { ...initialContent, summary: "Edited" } });
		});
		expect(editAiContent).toHaveBeenCalledTimes(1);
		expect(queryClient.getQueryData(["videoStatus", videoId])).toMatchObject({
			summary: "Edited",
			name: "Video name",
			aiGenerationStatus: "COMPLETE",
		});
		expect(onClose).toHaveBeenCalledWith(true);
	});
	it("retains a failed draft and allows retry", async () => {
		vi.mocked(editAiContent).mockResolvedValue({
			success: false,
			message: "Conflict: content changed",
		});
		await render();
		await change(summary(), "Unsaved draft");
		await act(async () => button("Save changes").click());
		expect(summary().value).toBe("Unsaved draft");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Conflict",
		);
		expect(button("Save changes").disabled).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
	});
	it("adds and removes chapters and rejects out-of-range timestamps", async () => {
		await render();
		await act(async () => button("Add chapter").click());
		expect(container.querySelectorAll("input")).toHaveLength(6);
		expect(button("Save changes").disabled).toBe(true);
		const inputs = Array.from(container.querySelectorAll("input"));
		const time = inputs[4];
		const title = inputs[5];
		if (!time || !title) throw new Error("New chapter missing");
		await change(title, "Conclusion");
		await change(time, "02:00");
		expect(container.textContent).toContain("before the video ends");
		await change(time, "01:30");
		expect(button("Save changes").disabled).toBe(false);
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('[aria-label="Remove chapter 3"]')
				?.click(),
		);
		expect(container.querySelectorAll("input")).toHaveLength(4);
	});
	it("keeps a draft when incoming content changes", async () => {
		await render();
		await change(summary(), "My draft");
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent: { ...initialContent, summary: "New remote content" },
				duration: 120,
				onClose,
			}),
		);
		expect(summary().value).toBe("My draft");
		vi.mocked(editAiContent).mockResolvedValue({
			success: false,
			message: "Conflict",
		});
		await act(async () => button("Save changes").click());
		expect(editAiContent).toHaveBeenCalledWith(
			videoId,
			expect.objectContaining({ expected: initialContent }),
		);
	});
	it("does not change fractional chapter times when editing only text", async () => {
		const content = {
			...initialContent,
			chapters: [{ title: "Intro", start: 1.123456 }],
		};
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent: content,
				duration: 120,
				onClose,
			}),
		);
		await change(summary(), "Edited summary");
		vi.mocked(editAiContent).mockResolvedValue({
			success: false,
			message: "Try again",
		});
		await act(async () => button("Save changes").click());
		expect(editAiContent).toHaveBeenCalledWith(
			videoId,
			expect.objectContaining({
				value: { ...content, summary: "Edited summary" },
			}),
		);
	});
});

describe("summary permissions", () => {
	const props: ComponentProps<typeof Summary> = {
		videoId,
		ownerIsPro: true,
		isOwner: true,
		initialAiData: { ...initialContent, aiGenerationStatus: "COMPLETE" },
	};
	it.each([
		{ isOwner: false },
		{ ownerIsPro: false },
		{
			initialAiData: {
				...initialContent,
				aiGenerationStatus: "PROCESSING" as const,
			},
		},
	])("hides editing when unavailable", async (overrides) => {
		await render(createElement(Summary, { ...props, ...overrides }));
		expect(
			container.querySelector('[aria-label="Edit summary and chapters"]'),
		).toBeNull();
	});
	it("allows restoring a deliberately empty summary and chapters", async () => {
		await render(
			createElement(Summary, {
				...props,
				initialAiData: {
					summary: "",
					chapters: [],
					aiGenerationStatus: "COMPLETE",
				},
			}),
		);
		await act(async () => button("Edit").click());
		expect(summary().value).toBe("");
	});
	it("uses keyboard-accessible chapter seek buttons", async () => {
		const onSeek = vi.fn();
		await render(createElement(Summary, { ...props, onSeek }));
		const chapter = Array.from(container.querySelectorAll("button")).find(
			(node) => node.textContent?.includes("Next steps"),
		);
		await act(async () => chapter?.click());
		expect(onSeek).toHaveBeenCalledWith(60);
	});
});
