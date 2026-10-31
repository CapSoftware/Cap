// @vitest-environment jsdom

import {
	act,
	createElement,
	Profiler,
	type ProfilerOnRenderCallback,
	type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "@/app/s/[videoId]/_components/playback/PlaybackContext";
import { Comments } from "@/app/s/[videoId]/_components/tabs/Activity/Comments";
import type { CommentType } from "@/app/s/[videoId]/Share";

const mocks = vi.hoisted(() => ({
	user: { id: "viewer", name: "Viewer", imageUrl: null },
	rowRenders: 0,
	params: new URLSearchParams(),
	post: vi.fn(),
	remove: vi.fn(),
}));

vi.mock("@/actions/videos/new-comment", () => ({ newComment: mocks.post }));
vi.mock("@/actions/videos/delete-comment", () => ({
	deleteComment: mocks.remove,
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => mocks.user,
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => mocks.params,
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
}));
vi.mock("@/app/s/[videoId]/_components/media-comment/record-actions", () => ({
	RecordActionButtons: () => null,
}));
vi.mock("@cap/ui", async () => {
	const { Button } = await import(
		"../../../../packages/ui/src/components/Button"
	);
	return { Button };
});
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ content, children }: { content: string; children: ReactNode }) =>
		createElement("span", { title: content }, children),
}));
vi.mock("@/components/SignedImageUrl", () => ({
	SignedImageUrl: ({ name }: { name: string }) => {
		if (name.startsWith("Reviewer")) mocks.rowRenders++;
		return createElement("span", { "data-avatar": name });
	},
}));

function comment(id: string, parent = ""): CommentType {
	return {
		id: id as CommentType["id"],
		videoId: "video" as CommentType["videoId"],
		authorId: "viewer" as CommentType["authorId"],
		authorName: "Reviewer",
		authorImage: null,
		content: `Review ${id}\nPlease check this part of the recording.`,
		type: "text",
		parentCommentId: parent as CommentType["parentCommentId"],
		timestamp: 120,
		createdAt: new Date("2026-10-25T12:00:00Z"),
		updatedAt: new Date("2026-10-25T12:00:00Z"),
		mediaKey: null,
		mediaDuration: null,
		mediaMeta: null,
	};
}

function discussion(threads: number) {
	return Array.from({ length: threads }, (_, i) => [
		{
			...comment(`root-${i}`),
			timestamp: i * 12,
			...(i % 5 === 0 ? { type: "emoji" as const, content: "🎉" } : {}),
		},
		comment(`reply-${i}`, `root-${i}`),
		comment(`nested-${i}`, `reply-${i}`),
	]).flat();
}

let root: Root;
let container: HTMLDivElement;
let video: HTMLVideoElement;
let comments: CommentType[];
let durations: number[];
const seek = vi.fn();
const optimistic = vi.fn();
const success = vi.fn();
const setComments = vi.fn();
const showAuth = vi.fn();
const onRender: ProfilerOnRenderCallback = (_id, phase, duration) => {
	if (phase !== "mount") durations.push(duration);
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	mocks.params = new URLSearchParams();
	mocks.rowRenders = 0;
	mocks.user = { id: "viewer", name: "Viewer", imageUrl: null };
	mocks.post.mockResolvedValue(comment("saved", "root-0"));
	mocks.remove.mockResolvedValue(undefined);
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	comments = discussion(100);
	durations = [];
	container = document.createElement("div");
	video = document.createElement("video");
	video.currentTime = 42;
	document.body.append(video, container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	video.remove();
	vi.unstubAllGlobals();
});

async function render(onSeek = seek, disabled = false) {
	await act(async () => {
		const props = {
			videoRef: { current: video },
			stageRef: { current: null },
			children: createElement(
				Profiler,
				{ id: comments[0]?.videoId ?? "comments", onRender },
				createElement(Comments, {
					videoId: "video" as CommentType["videoId"],
					optimisticComments: comments,
					setOptimisticComments: optimistic,
					handleCommentSuccess: success,
					setComments,
					setShowAuthOverlay: showAuth,
					commentsDisabled: disabled,
					onSeek,
				}),
			),
		};
		root.render(createElement(PlaybackProvider, props));
	});
}

function row(id: string) {
	const element = container.querySelector<HTMLElement>(`#comment-${id}`);
	if (!element) throw new Error(`Missing comment ${id}`);
	return element;
}

async function click(element: HTMLElement | null) {
	if (!element) throw new Error("Missing button");
	await act(async () => element.click());
}

async function reply(id: string) {
	await click(
		row(id).querySelector<HTMLButtonElement>('[title="Reply"] button'),
	);
}

async function type(input: HTMLTextAreaElement | null, text: string) {
	if (!input) throw new Error("Missing comment editor");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function button(text: string) {
	return (
		Array.from(container.querySelectorAll("button")).find(
			(element) => element.textContent === text,
		) ?? null
	);
}

function contents() {
	return Array.from(
		container.querySelectorAll('[id^="comment-"]'),
		(element) => ({
			id: element.id,
			text: element.querySelector("p.mt-2")?.textContent,
		}),
	);
}

describe("share comments rendering", () => {
	it("only renders the affected threads when opening and switching replies", async () => {
		await render();
		expect(mocks.rowRenders).toBe(300);
		const initialContents = contents();
		mocks.rowRenders = 0;
		await reply("root-20");
		expect(row("root-20").querySelector("textarea")).not.toBeNull();
		expect(mocks.rowRenders).toBeLessThanOrEqual(3);
		mocks.rowRenders = 0;
		await reply("nested-40");
		expect(row("root-20").querySelector("textarea")).toBeNull();
		expect(row("nested-40").querySelector("textarea")).not.toBeNull();
		expect(mocks.rowRenders).toBeLessThanOrEqual(6);
		expect(contents()).toEqual(initialContents);
	});

	it("keeps typing and playback updates out of the comment rows", async () => {
		await render();
		await reply("reply-20");
		mocks.rowRenders = 0;
		await type(row("reply-20").querySelector("textarea"), "A reply draft");
		await type(
			container.querySelector('textarea[placeholder="Leave a comment"]'),
			"A comment draft",
		);
		await act(async () => {
			video.currentTime = 84;
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(row("reply-20").querySelector("textarea")?.value).toBe(
			"A reply draft",
		);
		expect(mocks.rowRenders).toBe(0);
	});

	it("skips unchanged rows on parent renders and refreshes changed content and permissions", async () => {
		comments = discussion(2);
		await render();
		mocks.rowRenders = 0;
		await render();
		expect(mocks.rowRenders).toBe(0);
		comments = comments.map((entry) =>
			entry.id === "reply-1" ? { ...entry, content: "Updated reply" } : entry,
		);
		await render();
		expect(row("reply-1").textContent).toContain("Updated reply");
		mocks.user = { id: "other-viewer", name: "Another viewer", imageUrl: null };
		await render();
		expect(container.querySelector('[title="Delete comment"]')).toBeNull();
		await reply("root-1");
		await type(
			row("root-1").querySelector("textarea"),
			"Reply as another viewer",
		);
		await click(button("Reply"));
		expect(optimistic).toHaveBeenCalledWith(
			expect.objectContaining({
				authorId: "other-viewer",
				parentCommentId: "root-1",
			}),
		);
	});

	it("preserves direct and legacy nested replies, order, emoji and multiline content", async () => {
		comments = discussion(3);
		comments.unshift(comment("orphan", "missing"));
		comments.push(comment("too-deep", "nested-0"));
		await render();
		const expected = comments
			.filter((entry) => !entry.parentCommentId)
			.flatMap((entry) => [
				entry,
				...comments.filter(
					(reply) =>
						reply.parentCommentId === entry.id ||
						comments.find((parent) => parent.id === reply.parentCommentId)
							?.parentCommentId === entry.id,
				),
			]);
		expect(contents()).toEqual(
			expected.map((entry) => ({
				id: `comment-${entry.id}`,
				text: entry.content,
			})),
		);
		expect(row("root-1").querySelector("p.mt-2")?.className).toContain(
			"whitespace-pre-wrap",
		);
	});

	it("uses the current reply target and callbacks when submitting or cancelling", async () => {
		comments = discussion(2);
		await render();
		await reply("root-0");
		await type(row("root-0").querySelector("textarea"), "Discarded");
		await click(button("Cancel"));
		expect(mocks.post).not.toHaveBeenCalled();
		await reply("nested-1");
		await type(row("nested-1").querySelector("textarea"), "Nested response");
		await click(button("Reply"));
		expect(mocks.post).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "Nested response",
				parentCommentId: "reply-1",
				timestamp: 42,
			}),
		);
		expect(optimistic).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "Nested response",
				parentCommentId: "reply-1",
				sending: true,
			}),
		);
		expect(success).toHaveBeenCalledWith(comment("saved", "root-0"));
		expect(row("nested-1").querySelector("textarea")).toBeNull();
		const updatedSeek = vi.fn();
		await render(updatedSeek);
		await click(row("root-1").querySelector("button.text-xs"));
		expect(updatedSeek).toHaveBeenCalledWith(12);
	});

	it("refreshes replies after optimistic additions, settlement and deletion", async () => {
		comments = discussion(2);
		await render();
		const pending = { ...comment("pending", "root-0"), sending: true };
		comments = [...comments, pending];
		await render();
		const mounted = row("pending");
		expect(mounted.className).toContain("opacity-20");
		comments = comments.map((entry) =>
			entry === pending
				? {
						...entry,
						id: "saved" as CommentType["id"],
						clientKey: "pending",
						sending: false,
					}
				: entry,
		);
		await render();
		expect(row("saved")).toBe(mounted);
		expect(row("saved").className).toContain("opacity-100");
		vi.spyOn(window, "confirm").mockReturnValue(true);
		await click(row("saved").querySelector('[title="Delete comment"] button'));
		expect(mocks.remove).toHaveBeenCalledWith({
			commentId: "saved",
			parentId: "root-0",
			videoId: "video",
		});
		comments = comments.filter((entry) => entry.id !== "saved");
		await render();
		expect(container.querySelector("#comment-saved")).toBeNull();
	});

	it("keeps failed replies open and handles empty and disabled discussions", async () => {
		comments = discussion(1);
		mocks.post.mockRejectedValue(new Error("Offline"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await render();
		await reply("root-0");
		await type(row("root-0").querySelector("textarea"), "Unsent");
		await click(button("Reply"));
		expect(row("root-0").querySelector("textarea")).not.toBeNull();
		expect(success).not.toHaveBeenCalled();
		comments = [];
		await render();
		expect(contents()).toEqual([]);
		await render(seek, true);
		expect(container.querySelector("textarea")).toBeNull();
	});

	it.skipIf(!process.env.CAP_COMMENTS_BENCH)(
		"profiles 100 threads with 300 comments",
		async () => {
			await render();
			const switching: number[] = [];
			const elapsed: number[] = [];
			const typing: number[] = [];
			let switchingRowRenders = 0;
			for (let i = 0; i < 40; i++) {
				durations = [];
				mocks.rowRenders = 0;
				const start = performance.now();
				await reply(i % 2 ? "root-20" : "nested-40");
				if (i >= 10) {
					switching.push(
						durations.reduce((sum, duration) => sum + duration, 0),
					);
					elapsed.push(performance.now() - start);
					switchingRowRenders += mocks.rowRenders;
				}
			}
			mocks.rowRenders = 0;
			for (let i = 0; i < 40; i++) {
				durations = [];
				await type(
					row("root-20").querySelector("textarea"),
					`Reply draft ${i}`,
				);
				if (i >= 10)
					typing.push(durations.reduce((sum, duration) => sum + duration, 0));
			}
			expect(switching).toHaveLength(30);
			expect(typing).toHaveLength(30);
			const median = (values: number[]) =>
				[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
			console.log(
				JSON.stringify({
					comments: 300,
					samples: 30,
					switchingMedianMs: median(switching),
					switchingElapsedMedianMs: median(elapsed),
					switchingRowRenders,
					typingMedianMs: median(typing),
					typingRowRenders: mocks.rowRenders,
				}),
			);
		},
		120000,
	);
});
