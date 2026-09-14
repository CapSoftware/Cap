import { describe, expect, it, vi } from "vitest";

type KeyHandler = (event: {
	key: string;
	target: unknown;
	preventDefault: () => void;
}) => void;

function createTimelineKeyHandler(playback: {
	seek: (time: number) => void;
	getCurrentTime: () => number;
	getDuration: () => number;
	getPlaying: () => boolean;
	play: () => void;
	pause: () => void;
}): KeyHandler {
	const KEYBOARD_SEEK_STEP = 5;

	return (event) => {
		const target = event.target as {
			tagName?: string;
			isContentEditable?: boolean;
			closest?: (sel: string) => unknown;
		} | null;

		if (
			target?.tagName === "INPUT" ||
			target?.tagName === "TEXTAREA" ||
			target?.isContentEditable
		) {
			return;
		}

		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const delta =
				event.key === "ArrowLeft" ? -KEYBOARD_SEEK_STEP : KEYBOARD_SEEK_STEP;
			playback.seek(playback.getCurrentTime() + delta);
			return;
		}

		if (event.key === "ArrowUp" || event.key === "Home") {
			event.preventDefault();
			playback.seek(0);
			return;
		}

		if (event.key === "ArrowDown" || event.key === "End") {
			event.preventDefault();
			playback.seek(playback.getDuration());
			return;
		}

		if (event.key === " " || event.key === "Spacebar") {
			if (target?.closest?.("[data-timeline-node]")) return;
			event.preventDefault();
			if (playback.getPlaying()) playback.pause();
			else playback.play();
		}
	};
}

describe("timeline keyboard navigation", () => {
	it("seeks to start (0) on ArrowUp and Home with preventDefault", () => {
		const seek = vi.fn();
		const preventDefault = vi.fn();
		const playback = {
			seek,
			getCurrentTime: () => 45,
			getDuration: () => 120,
			getPlaying: () => false,
			play: vi.fn(),
			pause: vi.fn(),
		};

		const handler = createTimelineKeyHandler(playback);

		handler({ key: "ArrowUp", target: null, preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(seek).toHaveBeenCalledWith(0);

		handler({ key: "Home", target: null, preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(2);
		expect(seek).toHaveBeenLastCalledWith(0);
	});

	it("seeks to end (duration) on ArrowDown and End with preventDefault", () => {
		const seek = vi.fn();
		const preventDefault = vi.fn();
		const playback = {
			seek,
			getCurrentTime: () => 10,
			getDuration: () => 120,
			getPlaying: () => false,
			play: vi.fn(),
			pause: vi.fn(),
		};

		const handler = createTimelineKeyHandler(playback);

		handler({ key: "ArrowDown", target: null, preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(seek).toHaveBeenCalledWith(120);

		handler({ key: "End", target: null, preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(2);
		expect(seek).toHaveBeenLastCalledWith(120);
	});

	it("does not navigate or prevent default when typing in inputs, textareas, or contenteditable", () => {
		const seek = vi.fn();
		const preventDefault = vi.fn();
		const playback = {
			seek,
			getCurrentTime: () => 10,
			getDuration: () => 120,
			getPlaying: () => false,
			play: vi.fn(),
			pause: vi.fn(),
		};

		const handler = createTimelineKeyHandler(playback);

		handler({ key: "ArrowUp", target: { tagName: "INPUT" }, preventDefault });
		handler({ key: "ArrowDown", target: { tagName: "TEXTAREA" }, preventDefault });
		handler({ key: "Home", target: { isContentEditable: true }, preventDefault });
		handler({ key: "End", target: { isContentEditable: true }, preventDefault });

		expect(seek).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
	});
});
