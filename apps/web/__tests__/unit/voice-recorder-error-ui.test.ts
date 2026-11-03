// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VoiceRecorderPanel } from "@/app/s/[videoId]/_components/timeline/recording/VoiceRecorderPanel";

const start = vi.hoisted(() => vi.fn());
vi.mock("@/app/s/[videoId]/_components/timeline/recording/DevicePill", () => ({
	DevicePill: () => null,
}));
vi.mock(
	"@/app/s/[videoId]/_components/timeline/recording/PauseResumeButton",
	() => ({ PauseResumeButton: () => null }),
);
vi.mock(
	"@/app/s/[videoId]/_components/timeline/recording/useVoiceRecorder",
	() => ({
		useVoiceRecorder: () => ({
			phase: "error",
			durationMs: 0,
			start,
			stop: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			restart: vi.fn(),
			switchMic: vi.fn(),
			cancel: vi.fn(),
		}),
	}),
);
vi.mock(
	"@/app/s/[videoId]/_components/timeline/recording/useCommentMediaDevices",
	() => ({
		useCommentMediaDevices: () => ({
			mics: [],
			selectedMicId: null,
			adoptMic: vi.fn(),
			refreshDevices: vi.fn(),
			selectMic: vi.fn(),
		}),
	}),
);
it("explains an encoder failure and offers retry", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				createElement(VoiceRecorderPanel, {
					timestamp: 0,
					onFinish: vi.fn(),
					onCancel: vi.fn(),
				}),
			),
		);
		expect(container.textContent).toContain(
			"Recording stopped unexpectedly. Please try again.",
		);
		const button = [...container.querySelectorAll("button")].find(
			(item) => item.textContent === "Try again",
		);
		expect(button).toBeDefined();
		await act(async () => button?.click());
		expect(start).toHaveBeenCalledTimes(1);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
