import { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileApiClient, MobileCapSummary } from "@/api/mobile";
import { showCapTitleActions } from "./titleActions";

const reactNativeMock = vi.hoisted(() => ({
	Alert: {
		alert: vi.fn(),
		prompt: vi.fn(),
	},
	Platform: {
		OS: "ios",
	},
}));

vi.mock("react-native", () => reactNativeMock);

const cap: MobileCapSummary = {
	id: Video.VideoId.make("video_123"),
	shareUrl: "https://cap.so/s/video_123",
	title: "Launch review",
	createdAt: "2026-05-18T10:00:00.000Z",
	updatedAt: "2026-05-18T10:30:00.000Z",
	ownerName: "Richie",
	durationSeconds: null,
	thumbnailUrl: null,
	folderId: null,
	public: true,
	protected: false,
	viewCount: 0,
	commentCount: 0,
	reactionCount: 0,
	upload: null,
};

describe("showCapTitleActions", () => {
	beforeEach(() => {
		reactNativeMock.Alert.alert.mockClear();
		reactNativeMock.Alert.prompt.mockClear();
		reactNativeMock.Platform.OS = "ios";
	});

	it("uses a native prompt to rename a Cap", async () => {
		const updated = { ...cap, title: "Roadmap review" };
		const updateCapTitle = vi.fn(async () => updated);
		const onUpdated = vi.fn();

		showCapTitleActions({
			cap,
			client: { updateCapTitle } as unknown as MobileApiClient,
			onUpdated,
		});

		expect(reactNativeMock.Alert.prompt).toHaveBeenCalledWith(
			"Rename Cap",
			undefined,
			expect.any(Array),
			"plain-text",
			"Launch review",
		);

		const buttons = reactNativeMock.Alert.prompt.mock.calls[0]?.[2];
		const saveButton = Array.isArray(buttons) ? buttons[1] : undefined;
		saveButton?.onPress?.(" Roadmap review ");
		await Promise.resolve();
		await Promise.resolve();

		expect(updateCapTitle).toHaveBeenCalledWith("video_123", {
			title: "Roadmap review",
		});
		expect(onUpdated).toHaveBeenCalledWith(updated);
	});

	it("rejects blank Cap titles before calling the API", () => {
		const updateCapTitle = vi.fn();

		showCapTitleActions({
			cap,
			client: { updateCapTitle } as unknown as MobileApiClient,
			onUpdated: vi.fn(),
		});

		const buttons = reactNativeMock.Alert.prompt.mock.calls[0]?.[2];
		const saveButton = Array.isArray(buttons) ? buttons[1] : undefined;
		saveButton?.onPress?.("   ");

		expect(updateCapTitle).not.toHaveBeenCalled();
		expect(reactNativeMock.Alert.alert).toHaveBeenCalledWith(
			"Title required",
			"Enter a title for this Cap.",
		);
	});
});
