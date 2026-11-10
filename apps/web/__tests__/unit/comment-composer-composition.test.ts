// @vitest-environment jsdom

import type { Comment, Organisation, User, Video } from "@cap/web-domain";
import type { ComponentProps } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newComment } from "@/actions/videos/new-comment";
import { Toolbar } from "@/app/s/[videoId]/_components/Toolbar";
import CommentInput from "@/app/s/[videoId]/_components/tabs/Activity/CommentInput";
import { TimelineComposer } from "@/app/s/[videoId]/_components/timeline/TimelineComposer";
import {
	TimelineProvider,
	useTimelineActions,
} from "@/app/s/[videoId]/_components/timeline/TimelineProvider";

vi.mock("@/actions/videos/new-comment", () => ({ newComment: vi.fn() }));
const showError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: showError } }));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "viewer", name: "Viewer", imageUrl: null }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/app/s/[videoId]/_components/AuthOverlayLazy", () => ({
	AuthOverlay: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/media-comment/record-actions", () => ({
	RecordActionButtons: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/timeline/TimelineBranch", () => ({
	MicGlyph: () => null,
}));
vi.mock("@cap/ui", async () => {
	const { Button } = await import(
		"../../../../packages/ui/src/components/Button"
	);
	return { Button };
});

const videoId = "video" as Video.VideoId;
const video = {
	id: videoId,
	orgId: "organization" as Organisation.OrganisationId,
	owner: { id: "owner" as User.UserId, isPro: false },
	name: "Test screenshot",
	bucket: null,
	storageIntegrationId: null,
	duration: null,
	width: null,
	height: null,
	fps: null,
	metadata: null,
	public: true,
	settings: null,
	transcriptionStatus: null,
	source: { type: "local" },
	folderId: null,
	createdAt: new Date(),
	effectiveCreatedAt: null,
	updatedAt: new Date(),
	password: null,
	xStreamInfo: null,
	firstViewEmailSentAt: null,
	isScreenshot: true,
	awsRegion: null,
	awsBucket: null,
	videoStartTime: null,
	audioStartTime: null,
	jobId: null,
	jobStatus: null,
	skipProcessing: false,
} satisfies ComponentProps<typeof Toolbar>["data"];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(newComment)
		.mockReset()
		.mockImplementation(async (data) => ({
			...data,
			id: "comment" as Comment.CommentId,
			authorId: "viewer" as User.UserId,
			authorName: "Viewer",
			createdAt: new Date(),
			updatedAt: new Date(),
			mediaKey: null,
			mediaDuration: null,
			mediaMeta: null,
			sending: false,
		}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
});

function TimelineHarness() {
	const actions = useTimelineActions();
	return createElement(
		"div",
		null,
		createElement(
			"button",
			{ type: "button", onClick: () => actions.openComposer(12) },
			"Open composer",
		),
		createElement(TimelineComposer, {
			videoId,
			trackWidth: 800,
			windowStart: 0,
			windowEnd: 60,
			viewerSignedIn: true,
		}),
	);
}

async function renderComposer(
	kind: "comment" | "reply" | "timeline" | "toolbar",
) {
	const submit = vi.fn();
	await act(async () => {
		if (kind === "timeline") {
			const props = {
				duration: 60,
				compact: false,
				hasHover: true,
				children: createElement(TimelineHarness),
			};
			root.render(createElement(TimelineProvider, props));
			return;
		}
		if (kind === "toolbar") {
			root.render(
				createElement(Toolbar, {
					data: video,
					disableReactions: true,
				}),
			);
			return;
		}
		root.render(
			createElement(CommentInput, {
				onSubmit: submit,
				buttonLabel: kind === "comment" ? "Comment" : "Reply",
				collapsible: kind === "comment",
				showCancelButton: kind === "reply",
				onCancel: vi.fn(),
			}),
		);
	});
	if (kind === "timeline" || kind === "toolbar") {
		const open = container.querySelector("button");
		if (!open) throw new Error("Composer trigger is missing");
		await act(async () => {
			open.click();
		});
	}
	const input = container.querySelector("textarea, input");
	if (
		!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)
	) {
		throw new Error("Comment field is missing");
	}
	return {
		input,
		submit:
			kind === "timeline" || kind === "toolbar"
				? vi.mocked(newComment)
				: submit,
	};
}

async function change(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	await act(async () => {
		const prototype =
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
		if (!setter) throw new Error("Field value setter is missing");
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe.each(["comment", "reply", "timeline", "toolbar"] as const)(
	"%s text composer",
	(kind) => {
		it("keeps the draft when Enter confirms an input method composition", async () => {
			const { input, submit } = await renderComposer(kind);
			await act(async () => {
				input.dispatchEvent(
					new CompositionEvent("compositionstart", { bubbles: true }),
				);
			});
			await change(input, "日本語");
			const confirm = new KeyboardEvent("keydown", {
				key: "Enter",
				isComposing: true,
				bubbles: true,
				cancelable: true,
			});
			await act(async () => {
				input.dispatchEvent(confirm);
			});

			expect(submit).not.toHaveBeenCalled();
			expect(input.isConnected).toBe(true);
			expect(input.value).toBe("日本語");
			expect(confirm.defaultPrevented).toBe(false);

			await act(async () => {
				input.dispatchEvent(
					new CompositionEvent("compositionend", {
						data: "日本語",
						bubbles: true,
					}),
				);
			});
			await act(async () => {
				input.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						bubbles: true,
						cancelable: true,
					}),
				);
			});
			expect(submit).toHaveBeenCalledOnce();
			if (kind === "comment" || kind === "reply")
				expect(submit).toHaveBeenCalledWith("日本語");
			else
				expect(submit).toHaveBeenCalledWith(
					expect.objectContaining({ content: "日本語", videoId }),
				);
		});
	},
);

it("leaves Shift+Enter available for multiline replies", async () => {
	const { input, submit } = await renderComposer("reply");
	await change(input, "First line");
	const newline = new KeyboardEvent("keydown", {
		key: "Enter",
		shiftKey: true,
		bubbles: true,
		cancelable: true,
	});
	await act(async () => {
		input.dispatchEvent(newline);
	});
	expect(newline.defaultPrevented).toBe(false);
	expect(submit).not.toHaveBeenCalled();
	expect(input.value).toBe("First line");
});

it.each(["success", "failure"])(
	"keeps a new toolbar draft when an earlier reaction finishes with %s",
	async (outcome) => {
		const respond = vi.mocked(newComment).getMockImplementation();
		if (!respond) throw new Error("Missing comment response");
		const reactionSave = Promise.withResolvers<void>();
		vi.mocked(newComment).mockImplementationOnce(async (data) => {
			await reactionSave.promise;
			return respond(data);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const success = vi.fn();
		await act(async () => {
			root.render(
				createElement(Toolbar, { data: video, onCommentSuccess: success }),
			);
		});
		const reaction = container.querySelector<HTMLButtonElement>(
			'button[aria-label="up"]',
		);
		if (!reaction) throw new Error("Missing reaction button");
		await act(async () => reaction.click());
		expect(newComment).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ content: "👍", type: "emoji" }),
		);
		const open = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Comment"),
		);
		if (!open) throw new Error("Missing comment button");
		await act(async () => open.click());
		const input = container.querySelector("input");
		if (!input) throw new Error("Missing comment field");
		await change(input, "A new draft after reacting");
		await act(async () => {
			if (outcome === "success") reactionSave.resolve();
			else reactionSave.reject(new Error("Offline"));
		});
		expect(input.value).toBe("A new draft after reacting");
		expect(container.querySelector("input")).toBe(input);
		expect(success).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
	},
);

it("keeps the toolbar draft open and says so when the comment fails to post", async () => {
	vi.mocked(newComment).mockRejectedValueOnce(
		new Error("Feedback is disabled on this video"),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
	showError.mockReset();
	const success = vi.fn();
	await act(async () => {
		root.render(
			createElement(Toolbar, {
				data: video,
				disableReactions: true,
				onCommentSuccess: success,
			}),
		);
	});
	const open = container.querySelector("button");
	if (!open) throw new Error("Missing comment button");
	await act(async () => open.click());
	const input = container.querySelector("input");
	if (!input) throw new Error("Missing comment field");
	await change(input, "Worth keeping");
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	expect(newComment).toHaveBeenCalledOnce();
	expect(success).not.toHaveBeenCalled();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Couldn't post your comment. Please try again.",
	);
	expect(container.querySelector("input")).toBe(input);
	expect(input.value).toBe("Worth keeping");
});

it("brings the timeline draft back and says so when the comment fails to post", async () => {
	vi.mocked(newComment).mockRejectedValueOnce(
		new Error("Feedback is disabled on this video"),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
	showError.mockReset();
	const { input } = await renderComposer("timeline");
	await change(input, "Worth keeping");
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	expect(newComment).toHaveBeenCalledOnce();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Couldn't post your comment. Please try again.",
	);
	const restored = container.querySelector("input");
	expect(restored?.value).toBe("Worth keeping");
	expect(restored?.getAttribute("aria-label")).toBe(
		input.getAttribute("aria-label"),
	);
});

it("leaves a newer timeline draft alone when an earlier comment fails", async () => {
	const save = Promise.withResolvers<Awaited<ReturnType<typeof newComment>>>();
	vi.mocked(newComment).mockImplementationOnce(() => save.promise);
	vi.spyOn(console, "error").mockImplementation(() => {});
	showError.mockReset();
	const { input } = await renderComposer("timeline");
	await change(input, "First draft");
	await act(async () => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
	});
	const open = container.querySelector("button");
	if (!open) throw new Error("Composer trigger is missing");
	await act(async () => open.click());
	const newer = container.querySelector("input");
	if (!newer) throw new Error("Missing comment field");
	await change(newer, "Newer draft");
	await act(async () => {
		save.reject(new Error("Offline"));
	});

	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Couldn't post your comment. Please try again.",
	);
	expect(container.querySelector("input")).toBe(newer);
	expect(newer.value).toBe("Newer draft");
});
