import { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileApiClient, MobileCapSummary } from "@/api/mobile";
import { showCapPasswordActions } from "./passwordActions";

const reactNativeMock = vi.hoisted(() => ({
	ActionSheetIOS: {
		showActionSheetWithOptions: vi.fn(),
	},
	Alert: {
		alert: vi.fn(),
		prompt: vi.fn(),
	},
	Platform: {
		OS: "ios",
	},
	StyleSheet: {
		create: <T extends Record<string, unknown>>(styles: T) => styles,
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

describe("showCapPasswordActions", () => {
	beforeEach(() => {
		reactNativeMock.ActionSheetIOS.showActionSheetWithOptions.mockClear();
		reactNativeMock.Alert.alert.mockClear();
		reactNativeMock.Alert.prompt.mockClear();
	});

	it("uses a native secure prompt to add a Cap password", async () => {
		const updated = { ...cap, protected: true };
		const updateCapPassword = vi.fn(async () => updated);
		const onUpdated = vi.fn();

		showCapPasswordActions({
			cap,
			client: { updateCapPassword } as unknown as MobileApiClient,
			onUpdated,
		});

		expect(reactNativeMock.Alert.prompt).toHaveBeenCalledWith(
			"Add password",
			"Set a password for this Cap link.",
			expect.any(Array),
			"secure-text",
		);

		const buttons = reactNativeMock.Alert.prompt.mock.calls[0]?.[2];
		const saveButton = Array.isArray(buttons) ? buttons[1] : undefined;
		saveButton?.onPress?.(" secret ");
		await Promise.resolve();
		await Promise.resolve();

		expect(updateCapPassword).toHaveBeenCalledWith("video_123", {
			password: "secret",
		});
		expect(onUpdated).toHaveBeenCalledWith(updated);
	});

	it("uses a native action sheet to remove an existing password", async () => {
		const protectedCap = { ...cap, protected: true };
		const updated = { ...protectedCap, protected: false };
		const updateCapPassword = vi.fn(async () => updated);
		const onUpdated = vi.fn();

		showCapPasswordActions({
			cap: protectedCap,
			client: { updateCapPassword } as unknown as MobileApiClient,
			onUpdated,
		});

		expect(
			reactNativeMock.ActionSheetIOS.showActionSheetWithOptions,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 2,
				destructiveButtonIndex: 1,
				options: ["Change password", "Remove password", "Cancel"],
				title: "Password protected",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);

		const callback =
			reactNativeMock.ActionSheetIOS.showActionSheetWithOptions.mock
				.calls[0]?.[1];
		callback?.(1);
		await Promise.resolve();
		await Promise.resolve();

		expect(updateCapPassword).toHaveBeenCalledWith("video_123", {
			password: null,
		});
		expect(onUpdated).toHaveBeenCalledWith(updated);
	});
});
