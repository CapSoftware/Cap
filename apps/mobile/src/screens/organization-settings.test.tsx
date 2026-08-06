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
});
