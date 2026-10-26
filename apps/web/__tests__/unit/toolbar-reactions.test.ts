import { describe, expect, it, vi } from "vitest";
import {
	handleEmojiReaction,
	REACTIONS,
} from "@/app/s/[videoId]/_components/toolbar-reactions";

describe("toolbar reactions", () => {
	it("exposes the standard reaction set in display order", () => {
		expect(REACTIONS).toEqual([
			{ emoji: "😂", label: "joy" },
			{ emoji: "😍", label: "love" },
			{ emoji: "😮", label: "wow" },
			{ emoji: "🙌", label: "yay" },
			{ emoji: "👍", label: "up" },
			{ emoji: "👎", label: "down" },
		]);
	});

	it("prompts sign-in overlay when unauthenticated viewer reacts", () => {
		const onRequireAuth = vi.fn();
		const onReact = vi.fn();

		handleEmojiReaction({
			emoji: "😂",
			canReact: true,
			user: null,
			onRequireAuth,
			onReact,
		});

		expect(onRequireAuth).toHaveBeenCalledOnce();
		expect(onReact).not.toHaveBeenCalled();
	});

	it("prompts sign-in overlay when user is undefined", () => {
		const onRequireAuth = vi.fn();
		const onReact = vi.fn();

		handleEmojiReaction({
			emoji: "👍",
			canReact: true,
			user: undefined,
			onRequireAuth,
			onReact,
		});

		expect(onRequireAuth).toHaveBeenCalledOnce();
		expect(onReact).not.toHaveBeenCalled();
	});

	it("suppresses interaction when reactions are disabled", () => {
		const onRequireAuth = vi.fn();
		const onReact = vi.fn();

		handleEmojiReaction({
			emoji: "😍",
			canReact: false,
			user: null,
			onRequireAuth,
			onReact,
		});

		expect(onRequireAuth).not.toHaveBeenCalled();
		expect(onReact).not.toHaveBeenCalled();
	});

	it("submits reaction when viewer is signed in", () => {
		const onRequireAuth = vi.fn();
		const onReact = vi.fn();

		handleEmojiReaction({
			emoji: "🙌",
			canReact: true,
			user: { id: "user-123" },
			onRequireAuth,
			onReact,
		});

		expect(onRequireAuth).not.toHaveBeenCalled();
		expect(onReact).toHaveBeenCalledOnce();
		expect(onReact).toHaveBeenCalledWith("🙌", { id: "user-123" });
	});
});
