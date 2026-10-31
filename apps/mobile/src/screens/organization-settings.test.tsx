import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationSettingsScreen from "../../app/organization-settings";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const settings = {
	id: "org_123",
	name: "Cap",
	role: "owner" as const,
	canManage: true,
	iconUrl: null,
	allowedEmailDomain: null,
	customDomain: "video.cap.so",
	domainVerified: true,
};

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		bootstrap: { activeOrganizationId: "org_123" },
		client: {
			getOrganizationSettings: vi.fn(),
			removeOrganizationIcon: vi.fn(),
			updateOrganizationIcon: vi.fn(),
			updateOrganizationSettings: vi.fn(),
		},
		refresh: vi.fn(),
	},
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
		await Promise.resolve();
		await Promise.resolve();
	});
	return renderer as unknown as ReactTestRenderer;
};

const getTextNodes = (node: JsonNode): string[] => {
	if (!node) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(getTextNodes);
	return node.children?.flatMap(getTextNodes) ?? [];
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);
	return {
		ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
		ActivityIndicator: createHost("ActivityIndicator"),
		Alert: { alert: vi.fn() },
		Linking: { openSettings: vi.fn() },
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
	return { Image: (props: HostProps) => React.createElement("Image", props) };
});

vi.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: vi.fn(),
	requestMediaLibraryPermissionsAsync: vi.fn(),
}));

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		Stack: {
			Screen: (props: HostProps) => React.createElement("StackScreen", props),
		},
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: HostProps) => React.createElement("SymbolView", props),
	};
});

vi.mock("@/api/mobile", () => ({
	MobileApiError: class MobileApiError extends Error {
		constructor(
			message: string,
			readonly status: number,
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
	return { SignInPanel: () => React.createElement("SignInPanel") };
});

vi.mock("@/components/ActionButton", async () => {
	const React = await import("react");
	return {
		ActionButton: ({ label, ...props }: HostProps & { label: string }) =>
			React.createElement("ActionButton", {
				...props,
				accessibilityLabel: label,
			}),
	};
});

vi.mock("@/components/GlassSurface", async () => {
	const React = await import("react");
	return {
		GlassSurface: ({ children }: HostProps) =>
			React.createElement("GlassSurface", null, children),
	};
});

vi.mock("@/components/Screen", async () => {
	const React = await import("react");
	return {
		Screen: ({ children }: HostProps) =>
			React.createElement("Screen", null, children),
	};
});

vi.mock("@/components/CapLoadingIndicator", async () => {
	const React = await import("react");
	return {
		CapLoadingIndicator: (props: HostProps) =>
			React.createElement("CapLoadingIndicator", props),
	};
});

describe("OrganizationSettingsScreen", () => {
	beforeEach(() => {
		auth.value.bootstrap.activeOrganizationId = "org_123";
		auth.value.client.getOrganizationSettings.mockReset();
		auth.value.client.getOrganizationSettings.mockResolvedValue(settings);
		auth.value.client.updateOrganizationSettings.mockReset();
		auth.value.client.updateOrganizationSettings.mockResolvedValue({
			...settings,
			name: "Cap Studio",
		});
		auth.value.refresh.mockReset();
		auth.value.refresh.mockResolvedValue(undefined);
	});

	it("loads editable native organization details", async () => {
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		const text = getTextNodes(renderer.toJSON());

		expect(auth.value.client.getOrganizationSettings).toHaveBeenCalledTimes(1);
		expect(text).toContain("Organization settings");
		expect(text).toContain("video.cap.so");
		expect(text).toContain("Verified");
	});

	it("saves common details and refreshes the account bootstrap", async () => {
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		const [nameInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization name",
		});
		if (!nameInput) throw new Error("Organization name input was not rendered");

		await act(async () => {
			nameInput.props.onChangeText("Cap Studio");
		});
		const [saveButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Save changes",
		});
		if (!saveButton) throw new Error("Save button was not rendered");

		await act(async () => {
			saveButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(auth.value.client.updateOrganizationSettings).toHaveBeenCalledWith({
			name: "Cap Studio",
			allowedEmailDomain: null,
		});
		expect(auth.value.refresh).toHaveBeenCalledTimes(1);
	});

	it("replaces drafts when the active organization changes", async () => {
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		const input = renderer.root.findByProps({
			accessibilityLabel: "Organization name",
		});
		await act(async () => input.props.onChangeText("Unfinished A"));
		auth.value.client.getOrganizationSettings.mockResolvedValueOnce({
			...settings,
			id: "org_b",
			name: "Organization B",
		});
		auth.value.bootstrap.activeOrganizationId = "org_b";
		await act(async () => {
			renderer.update(React.createElement(OrganizationSettingsScreen));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(
			renderer.root.findByProps({ accessibilityLabel: "Organization name" })
				.props.value,
		).toBe("Organization B");
		await act(async () => renderer.unmount());
	});

	it("ignores an old settings save after switching organizations", async () => {
		let resolveSave!: (value: typeof settings) => void;
		auth.value.client.updateOrganizationSettings.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
		);
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		await act(async () =>
			renderer.root
				.findByProps({ accessibilityLabel: "Organization name" })
				.props.onChangeText("A draft"),
		);
		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Save changes" })
				.props.onPress();
		});
		auth.value.client.getOrganizationSettings.mockResolvedValueOnce({
			...settings,
			id: "org_b",
			name: "Organization B",
		});
		auth.value.bootstrap.activeOrganizationId = "org_b";
		await act(async () => {
			renderer.update(React.createElement(OrganizationSettingsScreen));
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			resolveSave({ ...settings, name: "A saved" });
			await Promise.resolve();
		});
		expect(
			renderer.root.findByProps({ accessibilityLabel: "Organization name" })
				.props.value,
		).toBe("Organization B");
		await act(async () => renderer.unmount());
	});

	it("does not upload a photo selected for a previous organization", async () => {
		const { ActionSheetIOS } = await import("react-native");
		const picker = await import("expo-image-picker");
		let finishPicker!: (
			value: Awaited<ReturnType<typeof picker.launchImageLibraryAsync>>,
		) => void;
		vi.mocked(picker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
			granted: true,
		} as Awaited<
			ReturnType<typeof picker.requestMediaLibraryPermissionsAsync>
		>);
		vi.mocked(picker.launchImageLibraryAsync).mockReturnValueOnce(
			new Promise((resolve) => {
				finishPicker = resolve;
			}),
		);
		auth.value.client.updateOrganizationIcon
			.mockReset()
			.mockResolvedValue(settings);
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Organization icon" })
				.props.onPress();
		});
		const choose = vi
			.mocked(ActionSheetIOS.showActionSheetWithOptions)
			.mock.calls.at(-1)?.[1];
		if (!choose) throw new Error("Missing icon action");
		await act(async () => {
			choose(0);
			await Promise.resolve();
		});
		auth.value.client.getOrganizationSettings.mockResolvedValueOnce({
			...settings,
			id: "org_b",
			name: "Organization B",
		});
		auth.value.bootstrap.activeOrganizationId = "org_b";
		await act(async () => {
			renderer.update(React.createElement(OrganizationSettingsScreen));
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => {
			finishPicker({
				canceled: false,
				assets: [
					{
						uri: "file:///photo.jpg",
						width: 10,
						height: 10,
						base64: "abcd",
						mimeType: "image/jpeg",
					},
				],
			});
			await Promise.resolve();
		});
		expect(auth.value.client.updateOrganizationIcon).not.toHaveBeenCalled();
		await act(async () => renderer.unmount());
	});
	it("refuses to show editable settings for a different server organization", async () => {
		auth.value.client.getOrganizationSettings.mockResolvedValueOnce({
			...settings,
			id: "org_b",
			name: "Organization B",
		});
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		expect(getTextNodes(renderer.toJSON()).join(" ")).toContain(
			"The active organization changed",
		);
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Organization name" }),
		).toHaveLength(0);
		await act(async () => renderer.unmount());
	});

	it("ignores a previous organization's delayed icon action", async () => {
		const { ActionSheetIOS } = await import("react-native");
		const picker = await import("expo-image-picker");
		vi.mocked(picker.requestMediaLibraryPermissionsAsync).mockReset();
		const renderer = await renderComponent(
			React.createElement(OrganizationSettingsScreen),
		);
		await act(async () =>
			renderer.root
				.findByProps({ accessibilityLabel: "Organization icon" })
				.props.onPress(),
		);
		const choose = vi
			.mocked(ActionSheetIOS.showActionSheetWithOptions)
			.mock.calls.at(-1)?.[1];
		if (!choose) throw new Error("Missing icon action");
		auth.value.client.getOrganizationSettings.mockResolvedValueOnce({
			...settings,
			id: "org_b",
			name: "Organization B",
		});
		auth.value.bootstrap.activeOrganizationId = "org_b";
		await act(async () => {
			renderer.update(React.createElement(OrganizationSettingsScreen));
			await Promise.resolve();
			await Promise.resolve();
		});
		await act(async () => choose(0));
		expect(picker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
		await act(async () => renderer.unmount());
	});
});
