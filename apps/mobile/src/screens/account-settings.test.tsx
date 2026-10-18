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
		apiKey: "mobile-key",
		bootstrap: {
			activeOrganizationId: "org_123",
			user: {
				email: "richie@cap.so",
				imageUrl: null,
				lastName: "McIlroy",
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

const billing = vi.hoisted(() => ({
	getProPlan: vi.fn(
		(): Promise<{
			upgraded: boolean;
			stripeSubscriptionStatus: string | null;
		}> =>
			Promise.resolve({
				upgraded: false,
				stripeSubscriptionStatus: null,
			}),
	),
}));

const actionSheet = vi.hoisted(() => ({
	showActionSheetWithOptions: vi.fn(),
}));

const linking = vi.hoisted(() => ({
	openSettings: vi.fn(() => Promise.resolve()),
	openURL: vi.fn(() => Promise.resolve()),
}));

const router = vi.hoisted(() => ({
	push: vi.fn(),
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
		ActionSheetIOS: actionSheet,
		ActivityIndicator: createHost("ActivityIndicator"),
		Alert: { alert: vi.fn() },
		Linking: linking,
		Platform: { OS: "ios" },
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
			version: "1.0.0",
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

vi.mock("expo-router", () => ({ router }));

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
	useAuth: () => auth.value,
}));

vi.mock("@/billing/pro", () => billing);

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
		vi.clearAllMocks();
		billing.getProPlan.mockResolvedValue({
			upgraded: false,
			stripeSubscriptionStatus: null,
		});
		auth.value.refresh.mockResolvedValue(undefined);
		auth.value.setActiveOrganization.mockResolvedValue(undefined);
		auth.value.signOut.mockResolvedValue(undefined);
	});

	it("shows the Free plan limit without an external purchase action", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const text = getTextNodes(renderer.toJSON());
		const [freePlan] = renderer.root.findAllByProps({
			accessibilityLabel: "Cap plan: Free",
		});

		expect(freePlan).toBeDefined();
		expect(text).toContain("Free plan");
		expect(text).toContain("Free plan · Recordings are limited to 5 minutes");
		expect(
			renderer.root.findAllByProps({
				accessibilityLabel: "Upgrade to Cap Pro",
			}),
		).toHaveLength(0);
		expect(billing.getProPlan).toHaveBeenCalledWith({
			apiKey: "mobile-key",
			baseUrl: "https://cap.so",
		});
	});

	it("shows existing Cap Pro access without a purchase action", async () => {
		billing.getProPlan.mockResolvedValueOnce({
			upgraded: true,
			stripeSubscriptionStatus: "active",
		});
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const text = getTextNodes(renderer.toJSON());

		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Cap plan: Cap Pro" }),
		).not.toHaveLength(0);
		expect(text).toContain("Cap Pro");
		expect(text).toContain("Unlimited recording time");
	});

	it("offers plan retry without guessing a Free or Pro state", async () => {
		billing.getProPlan.mockRejectedValueOnce(new Error("offline"));
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const [unavailable] = renderer.root.findAllByProps({
			accessibilityLabel: "Cap plan unavailable",
		});

		expect(unavailable).toBeDefined();
		expect(getTextNodes(renderer.toJSON())).toContain("Tap to try again");
		await act(async () => {
			unavailable?.props.onPress();
		});
		expect(billing.getProPlan).toHaveBeenCalledTimes(2);
	});

	it("opens native profile, organization, and account deletion screens", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const routes = [
			["Name and Profile Image", "/profile-settings"],
			["Organization Settings", "/organization-settings"],
			["Delete account", "/delete-account"],
		] as const;

		for (const [label, route] of routes) {
			const [row] = renderer.root.findAllByProps({
				accessibilityLabel: label,
			});
			if (!row) throw new Error(`${label} row was not rendered`);
			await act(async () => {
				row.props.onPress();
			});
			expect(router.push).toHaveBeenLastCalledWith(route);
		}
	});

	it("opens help, privacy, and terms from the signed-in account", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const pages = [
			["Help & Support", "https://cap.so/docs"],
			["Privacy Policy", "https://cap.so/privacy"],
			["Terms of Service", "https://cap.so/terms"],
		] as const;

		for (const [label, url] of pages) {
			const [row] = renderer.root.findAllByProps({
				accessibilityLabel: label,
			});
			if (!row) throw new Error(`${label} row was not rendered`);
			await act(async () => {
				row.props.onPress();
			});
			expect(linking.openURL).toHaveBeenLastCalledWith(url);
		}
	});

	it("marks app settings as busy while the native view opens", async () => {
		const renderer = await renderComponent(React.createElement(AccountScreen));
		const [appSettings] = renderer.root.findAllByProps({
			accessibilityLabel: "App Settings",
		});
		if (!appSettings) throw new Error("App Settings row was not rendered");

		const { Linking } = await import("react-native");
		const openSettings = vi.mocked(Linking.openSettings);
		const openDeferred = createDeferred<void>();
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

	it("locks account actions while refresh is in progress", async () => {
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

		for (const label of [
			"Organization Settings",
			"App Settings",
			"Sign out",
			"Delete account",
		]) {
			const [row] = renderer.root.findAllByProps({
				accessibilityLabel: label,
			});
			expect(row?.props.disabled).toBe(true);
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

		await act(async () => {
			signOut.props.onPress();
		});
		const callback = actionSheet.showActionSheetWithOptions.mock
			.calls[0]?.[1] as ((index: number) => void) | undefined;
		if (!callback)
			throw new Error("Sign-out confirmation callback was not set");

		await act(async () => {
			callback(0);
			await Promise.resolve();
		});
		const [loadingSignOut] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign out",
		});
		expect(loadingSignOut?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Signing out...");

		await act(async () => {
			signOutDeferred.resolve();
			await signOutDeferred.promise;
		});
	});
});
