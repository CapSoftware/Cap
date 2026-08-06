import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProfileSettingsScreen from "../../app/profile-settings";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const profile = {
	id: "user_123",
	name: "Richie",
	lastName: "McIlroy",
	email: "richie@cap.so",
	imageUrl: null as string | null,
	activeOrganizationId: "org_123",
};

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		bootstrap: {
			user: {
				id: "user_123",
				name: "Richie",
				lastName: "McIlroy",
				email: "richie@cap.so",
				imageUrl: null as string | null,
				activeOrganizationId: "org_123",
			},
		},
		client: {
			updateProfile: vi.fn(),
			updateProfileImage: vi.fn(),
			removeProfileImage: vi.fn(),
		},
		refresh: vi.fn(() => Promise.resolve()),
	},
}));

const actionSheet = vi.hoisted(() => ({
	showActionSheetWithOptions: vi.fn(),
}));

const imagePicker = vi.hoisted(() => ({
	requestMediaLibraryPermissionsAsync: vi.fn(),
	launchImageLibraryAsync: vi.fn(),
}));

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const renderComponent = async (
	node: ReactElement,
): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return renderer as unknown as ReactTestRenderer;
};

const getTextNodes = (node: JsonNode): string[] => {
	if (!node) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(getTextNodes);
	return node.children?.flatMap(getTextNodes) ?? [];
};

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

const selectActionSheetOption = async (index: number) => {
	const callback = actionSheet.showActionSheetWithOptions.mock.calls.at(
		-1,
	)?.[1] as ((selectedIndex: number) => void) | undefined;
	if (!callback) throw new Error("Action sheet selection callback was not set");
	await act(async () => {
		callback(index);
		await flushMicrotasks();
	});
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		ActionSheetIOS: actionSheet,
		ActivityIndicator: createHost("ActivityIndicator"),
		Alert: { alert: vi.fn() },
		Linking: { openSettings: vi.fn(() => Promise.resolve()) },
		Platform: { OS: "ios" },
		Pressable: createHost("Pressable"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		TextInput: createHost("TextInput"),
		View: createHost("View"),
	};
});

vi.mock("expo-image", async () => {
	const React = await import("react");
	return {
		Image: (props: Record<string, unknown>) =>
			React.createElement("Image", props),
	};
});

vi.mock("expo-image-picker", () => imagePicker);

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		Stack: {
			Screen: (props: Record<string, unknown>) =>
				React.createElement("StackScreen", props),
		},
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: Record<string, unknown>) =>
			React.createElement("SymbolView", props),
	};
});

vi.mock("@/api/mobile", () => ({
	MobileApiError: class MobileApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
			readonly payload: unknown,
		) {
			super(message);
		}
	},
}));

vi.mock("@/auth/AuthContext", () => ({
	useAuth: () => auth.value,
}));

vi.mock("@/auth/SignInPanel", async () => {
	const React = await import("react");
	return {
		SignInPanel: () => React.createElement("SignInPanel"),
	};
});

vi.mock("@/components/GlassSurface", async () => {
	const React = await import("react");
	return {
		GlassSurface: ({ children }: { children?: ReactNode }) =>
			React.createElement("GlassSurface", null, children),
	};
});

vi.mock("@/components/Screen", async () => {
	const React = await import("react");
	return {
		Screen: ({ children }: { children?: ReactNode }) =>
			React.createElement("Screen", null, children),
	};
});

describe("ProfileSettingsScreen", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		actionSheet.showActionSheetWithOptions.mockReset();
		imagePicker.requestMediaLibraryPermissionsAsync.mockReset();
		imagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
			granted: true,
		});
		imagePicker.launchImageLibraryAsync.mockReset();
		imagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true });
		auth.value.bootstrap.user = { ...profile };
		auth.value.client.updateProfile.mockReset();
		auth.value.client.updateProfile.mockResolvedValue({ ...profile });
		auth.value.client.updateProfileImage.mockReset();
		auth.value.client.updateProfileImage.mockResolvedValue({
			...profile,
			imageUrl: "https://cap.so/profile.png",
		});
		auth.value.client.removeProfileImage.mockReset();
		auth.value.client.removeProfileImage.mockResolvedValue({ ...profile });
		auth.value.refresh.mockReset();
		auth.value.refresh.mockResolvedValue(undefined);
	});

	it("updates first and last name and refreshes Account data", async () => {
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [firstName] = renderer.root.findAllByProps({
			accessibilityLabel: "First name",
		});
		const [lastName] = renderer.root.findAllByProps({
			accessibilityLabel: "Last name",
		});
		if (!firstName || !lastName)
			throw new Error("Name fields were not rendered");

		expect(firstName.props.value).toBe("Richie");
		expect(lastName.props.value).toBe("McIlroy");
		await act(async () => {
			firstName.props.onChangeText("  Richard ");
			lastName.props.onChangeText("  McIlroy  ");
		});
		const [save] = renderer.root.findAllByProps({
			accessibilityLabel: "Save changes",
		});
		if (!save) throw new Error("Save changes button was not rendered");

		await act(async () => {
			save.props.onPress();
			await flushMicrotasks();
		});

		expect(auth.value.client.updateProfile).toHaveBeenCalledWith({
			name: "Richard",
			lastName: "McIlroy",
		});
		expect(auth.value.refresh).toHaveBeenCalledTimes(1);
		expect(getTextNodes(renderer.toJSON())).toContain("Profile updated.");
	});

	it("chooses and uploads a native profile image", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123456);
		imagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
			canceled: false,
			assets: [
				{
					base64: "/9j/",
					fileName: "avatar.png",
					fileSize: 5,
					mimeType: "image/png",
				},
			],
		});
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [image] = renderer.root.findAllByProps({
			accessibilityLabel: "Profile image",
		});
		const [firstName] = renderer.root.findAllByProps({
			accessibilityLabel: "First name",
		});
		if (!image || !firstName) {
			throw new Error("Profile image controls were not rendered");
		}

		await act(async () => {
			firstName.props.onChangeText("Richard");
			image.props.onPress();
		});
		await selectActionSheetOption(0);

		expect(imagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalled();
		expect(imagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
			allowsEditing: true,
			aspect: [1, 1],
			base64: true,
			mediaTypes: ["images"],
			quality: 0.8,
		});
		expect(auth.value.client.updateProfileImage).toHaveBeenCalledWith({
			data: "/9j/",
			contentType: "image/jpeg",
			fileName: "profile-123456.jpg",
		});
		expect(auth.value.refresh).toHaveBeenCalledTimes(1);
		expect(
			renderer.root.findByProps({ accessibilityLabel: "First name" }).props
				.value,
		).toBe("Richard");
		expect(getTextNodes(renderer.toJSON())).toContain("Profile image updated.");
	});

	it("removes the current profile image", async () => {
		auth.value.bootstrap.user = {
			...profile,
			imageUrl: "https://cap.so/existing.png",
		};
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [image] = renderer.root.findAllByProps({
			accessibilityLabel: "Profile image",
		});
		if (!image) throw new Error("Profile image button was not rendered");

		await act(async () => {
			image.props.onPress();
		});
		expect(actionSheet.showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				destructiveButtonIndex: 1,
				options: ["Choose Photo", "Remove Photo", "Cancel"],
			}),
			expect.any(Function),
		);
		await selectActionSheetOption(1);

		expect(auth.value.client.removeProfileImage).toHaveBeenCalledTimes(1);
		expect(auth.value.refresh).toHaveBeenCalledTimes(1);
		expect(getTextNodes(renderer.toJSON())).toContain("Profile image removed.");
	});

	it("rejects profile images larger than 1 MB before upload", async () => {
		imagePicker.launchImageLibraryAsync.mockResolvedValueOnce({
			canceled: false,
			assets: [
				{
					base64: "/9j/",
					fileName: "avatar.jpg",
					fileSize: 1024 * 1024 + 1,
					mimeType: "image/jpeg",
				},
			],
		});
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [image] = renderer.root.findAllByProps({
			accessibilityLabel: "Profile image",
		});
		if (!image) throw new Error("Profile image button was not rendered");

		await act(async () => {
			image.props.onPress();
		});
		await selectActionSheetOption(0);

		expect(auth.value.client.updateProfileImage).not.toHaveBeenCalled();
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Choose a PNG or JPEG that is 1 MB or smaller.",
		);
	});

	it("offers Settings when photo access is denied", async () => {
		imagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({
			granted: false,
		});
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [image] = renderer.root.findAllByProps({
			accessibilityLabel: "Profile image",
		});
		if (!image) throw new Error("Profile image button was not rendered");

		await act(async () => {
			image.props.onPress();
		});
		await selectActionSheetOption(0);

		expect(imagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
		expect(actionSheet.showActionSheetWithOptions).toHaveBeenLastCalledWith(
			expect.objectContaining({
				message: "Allow Cap to choose a profile image from Settings.",
				options: ["Open Settings", "Cancel"],
				title: "Photos access needed",
			}),
			expect.any(Function),
		);
	});

	it("recovers from a failed name update", async () => {
		auth.value.client.updateProfile.mockRejectedValueOnce(new Error("offline"));
		const renderer = await renderComponent(
			React.createElement(ProfileSettingsScreen),
		);
		const [firstName] = renderer.root.findAllByProps({
			accessibilityLabel: "First name",
		});
		if (!firstName) throw new Error("First name field was not rendered");
		await act(async () => {
			firstName.props.onChangeText("Richard");
		});
		const [save] = renderer.root.findAllByProps({
			accessibilityLabel: "Save changes",
		});
		if (!save) throw new Error("Save changes button was not rendered");

		await act(async () => {
			save.props.onPress();
			await flushMicrotasks();
		});
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Your profile could not be updated. Check your connection and try again.",
		);

		auth.value.client.updateProfile.mockResolvedValueOnce({
			...profile,
			name: "Richard",
		});
		const [retry] = renderer.root.findAllByProps({
			accessibilityLabel: "Save changes",
		});
		if (!retry) throw new Error("Save changes button was not rendered");
		await act(async () => {
			retry.props.onPress();
			await flushMicrotasks();
		});

		expect(auth.value.client.updateProfile).toHaveBeenCalledTimes(2);
		expect(getTextNodes(renderer.toJSON())).toContain("Profile updated.");
	});
});
