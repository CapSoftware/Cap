import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountScreen from "../../app/(tabs)/account";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		bootstrap: {
			activeOrganizationId: "org_123",
			user: {
				email: "richie@cap.so",
				imageUrl: null,
				name: "Richie",
			},
			organizations: [
				{
					id: "org_123",
					iconUrl: null,
					name: "Cap",
					role: "owner",
				},
			],
			rootFolders: [],
		},
		refresh: vi.fn(() => Promise.resolve()),
		setActiveOrganization: vi.fn(() => Promise.resolve()),
		signOut: vi.fn(() => Promise.resolve()),
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
	});
	return renderer as unknown as ReactTestRenderer;
};

const getTextNodes = (node: JsonNode): string[] => {
	if (!node) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(getTextNodes);
	return node.children?.flatMap(getTextNodes) ?? [];
};

const createDeferred = <T,>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		ActionSheetIOS: {
			showActionSheetWithOptions: vi.fn(),
		},
		ActivityIndicator: createHost("ActivityIndicator"),
		Alert: {
			alert: vi.fn(),
		},
		Linking: {
			openSettings: vi.fn(),
		},
		Platform: {
			OS: "ios",
		},
		Pressable: createHost("Pressable"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		View: createHost("View"),
	};
});

vi.mock("expo-constants", () => ({
	default: {
		expoConfig: {
			version: "0.1.0",
		},
	},
}));

vi.mock("expo-image", async () => {
	const React = await import("react");
	return {
		Image: (props: Record<string, unknown>) =>
			React.createElement("Image", props),
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: Record<string, unknown>) =>
			React.createElement("SymbolView", props),
	};
});

vi.mock("expo-web-browser", () => ({
	openBrowserAsync: vi.fn(),
}));

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
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

vi.mock("@/components/OrgSwitcher", async () => {
	const React = await import("react");
	return {
		OrgSwitcher: () => React.createElement("OrgSwitcher"),
	};
});

vi.mock("@/components/Screen", async () => {
	const React = await import("react");
	return {
		Screen: ({
			children,
			subtitle,
			title,
		}: {
			children?: ReactNode;
			subtitle?: string | null;
			title?: string;
		}) =>
			React.createElement(
				"Screen",
				null,
				title ? React.createElement("Text", null, title) : null,
				subtitle ? React.createElement("Text", null, subtitle) : null,
				children,
			),
	};
});

describe("AccountScreen", () => {
	beforeEach(() => {
		auth.value.refresh.mockReset();
		auth.value.refresh.mockResolvedValue(undefined);
		auth.value.setActiveOrganization.mockReset();
		auth.value.setActiveOrganization.mockResolvedValue(undefined);
		auth.value.signOut.mockReset();
		auth.value.signOut.mockResolvedValue(undefined);
	});

	it("opens organization settings in the native browser sheet", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const text = getTextNodes(renderer.toJSON());
		const [organizationSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization Settings",
		});
		if (!organizationSettings) {
			throw new Error("Organization Settings row was not rendered");
		}

		expect(text).toContain("Account");
		expect(text).toContain("Organization Settings");
		expect(organizationSettings.props.accessibilityHint).toBe(
			"Opens organization settings in a browser sheet",
		);

		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		const openDeferred =
			createDeferred<Awaited<ReturnType<typeof WebBrowser.openBrowserAsync>>>();
		openBrowserAsync.mockClear();
		openBrowserAsync.mockReturnValueOnce(openDeferred.promise);

		await act(async () => {
			organizationSettings.props.onPress();
			await Promise.resolve();
		});

		expect(openBrowserAsync).toHaveBeenCalledWith(
			"https://cap.so/dashboard/settings/organization",
		);
		const [openingOrganizationSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization Settings",
		});
		expect(openingOrganizationSettings?.props.accessibilityValue).toEqual({
			text: "Opening organization settings",
		});

		await act(async () => {
			openDeferred.resolve({
				type: "dismiss",
			} as Awaited<ReturnType<typeof WebBrowser.openBrowserAsync>>);
			await openDeferred.promise;
		});
	});

	it("marks app settings as opening with a native value", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const [appSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "App Settings",
		});
		if (!appSettings) throw new Error("App Settings row was not rendered");

		const { Linking } = await import("react-native");
		const openSettings = vi.mocked(Linking.openSettings);
		const openDeferred = createDeferred<void>();
		openSettings.mockClear();
		openSettings.mockReturnValueOnce(openDeferred.promise);

		await act(async () => {
			appSettings.props.onPress();
			await Promise.resolve();
		});

		const [openingAppSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "App Settings",
		});
		expect(openingAppSettings?.props.accessibilityValue).toEqual({
			text: "Opening iOS app settings",
		});

		await act(async () => {
			openDeferred.resolve();
			await openDeferred.promise;
		});
	});

	it("locks account settings rows while refresh is in progress", async () => {
		const refreshDeferred = createDeferred<void>();
		auth.value.refresh.mockReturnValueOnce(refreshDeferred.promise);
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const [refreshRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Refresh",
		});
		if (!refreshRow) throw new Error("Refresh row was not rendered");

		await act(async () => {
			refreshRow.props.onPress();
			await Promise.resolve();
		});

		const [loadingRefreshRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Refresh",
		});
		const [organizationSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization Settings",
		});
		const [appSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "App Settings",
		});
		const [signOut] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign out",
		});
		if (
			!loadingRefreshRow ||
			!organizationSettings ||
			!appSettings ||
			!signOut
		) {
			throw new Error("Account action rows were not rendered");
		}

		expect(loadingRefreshRow.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loadingRefreshRow.props.accessibilityHint).toBe(
			"Refresh is in progress",
		);
		expect(loadingRefreshRow.props.accessibilityValue).toEqual({
			text: "Refreshing account data",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Refreshing...");
		for (const row of [organizationSettings, appSettings, signOut]) {
			expect(row.props.disabled).toBe(true);
			expect(row.props.accessibilityState).toEqual({
				busy: false,
				disabled: true,
			});
			expect(row.props.accessibilityHint).toBe("Refresh is in progress");
		}

		await act(async () => {
			refreshDeferred.resolve();
			await refreshDeferred.promise;
		});
	});

	it("shows sign-out as busy after confirmation", async () => {
		const signOutDeferred = createDeferred<void>();
		auth.value.signOut.mockReturnValueOnce(signOutDeferred.promise);
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const [signOut] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign out",
		});
		if (!signOut) throw new Error("Sign out row was not rendered");

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			signOut.props.onPress();
		});

		const [, callback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!callback)
			throw new Error("Sign-out confirmation callback was not set");

		await act(async () => {
			callback(0);
			await Promise.resolve();
		});

		const [loadingSignOut] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign out",
		});
		if (!loadingSignOut) throw new Error("Sign out row was not rendered");
		expect(loadingSignOut.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loadingSignOut.props.accessibilityHint).toBe(
			"Sign out is in progress",
		);
		expect(loadingSignOut.props.accessibilityValue).toEqual({
			text: "Signing out of Cap",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Signing out...");

		await act(async () => {
			signOutDeferred.resolve();
			await signOutDeferred.promise;
		});
	});
});
