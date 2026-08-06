import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInPanel } from "./SignInPanel";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const authFns = vi.hoisted(() => ({
	authConfig: {
		appleAuthAvailable: true,
		googleAuthAvailable: true,
		workosAuthAvailable: true,
	},
	requestEmailCode: vi.fn(() => Promise.resolve()),
	signInWithApple: vi.fn(),
	signInWithGoogle: vi.fn(),
	signInWithSso: vi.fn(),
	verifyEmailCode: vi.fn(),
}));

const appleAuthenticationFns = vi.hoisted(() => ({
	isAvailableAsync: vi.fn(() => Promise.resolve(true)),
}));

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const renderTree = async (node: ReactElement): Promise<JsonNode> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return (renderer as ReactTestRenderer | null)?.toJSON() ?? null;
};

const renderPanel = async (): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(React.createElement(SignInPanel));
	});
	return renderer as unknown as ReactTestRenderer;
};

const getTextNodes = (node: JsonNode): string[] => {
	if (!node) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(getTextNodes);
	return node.children?.flatMap(getTextNodes) ?? [];
};

const hasProp = (node: JsonNode, prop: string, value: unknown): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node))
		return node.some((item) => hasProp(item, prop, value));
	if (node.props[prop] === value) return true;
	return node.children?.some((child) => hasProp(child, prop, value)) ?? false;
};

const hasStyle = (
	node: JsonNode,
	expected: Record<string, unknown>,
): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some((item) => hasStyle(item, expected));
	const styles = Array.isArray(node.props.style)
		? node.props.style
		: [node.props.style];
	const resolved = Object.assign({}, ...styles.filter(Boolean));
	if (
		Object.entries(expected).every(([key, value]) => resolved[key] === value)
	) {
		return true;
	}
	return node.children?.some((child) => hasStyle(child, expected)) ?? false;
};

const resolveStyle = (
	style: unknown,
	pressed = false,
): Record<string, unknown> => {
	const resolved = typeof style === "function" ? style({ pressed }) : style;
	const styles = Array.isArray(resolved) ? resolved : [resolved];
	return Object.assign({}, ...styles.filter(Boolean));
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);
	const TextInput = React.forwardRef<unknown, HostProps>(
		({ children, ...props }, ref) =>
			React.createElement(
				"TextInput",
				{ ...props, ref },
				children as ReactNode,
			),
	);

	return {
		ActivityIndicator: createHost("ActivityIndicator"),
		Pressable: createHost("Pressable"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		TextInput,
		View: createHost("View"),
	};
});

vi.mock("expo-symbols", () => ({
	SymbolView: () => null,
}));

vi.mock("expo-apple-authentication", async () => {
	const React = await import("react");
	return {
		AppleAuthenticationButton: (props: HostProps) =>
			React.createElement(
				"AppleAuthenticationButton",
				props,
				"Sign in with Apple",
			),
		AppleAuthenticationButtonStyle: {
			BLACK: 0,
		},
		AppleAuthenticationButtonType: {
			SIGN_IN: 0,
		},
		isAvailableAsync: appleAuthenticationFns.isAvailableAsync,
	};
});

vi.mock("expo-web-browser", () => ({
	openBrowserAsync: vi.fn(),
}));

vi.mock("@/components/GlassSurface", async () => {
	const React = await import("react");
	return {
		GlassSurface: ({ children }: { children?: ReactNode }) =>
			React.createElement("GlassSurface", null, children),
	};
});

vi.mock("react-native-svg", async () => {
	const React = await import("react");
	const Svg = ({ children, ...props }: HostProps) =>
		React.createElement("Svg", props, children);

	return {
		default: Svg,
		Path: (props: HostProps) => React.createElement("Path", props),
		Rect: (props: HostProps) => React.createElement("Rect", props),
	};
});

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
	useAuth: () => ({
		authConfig: authFns.authConfig,
		requestEmailCode: authFns.requestEmailCode,
		signInWithApple: authFns.signInWithApple,
		signInWithGoogle: authFns.signInWithGoogle,
		signInWithSso: authFns.signInWithSso,
		verifyEmailCode: authFns.verifyEmailCode,
	}),
}));

vi.mock("@/api/mobile", () => ({
	MobileApiError: class MobileApiError extends Error {
		status: number;
		payload: unknown;

		constructor(message: string, status: number, payload: unknown) {
			super(message);
			this.status = status;
			this.payload = payload;
		}
	},
}));

describe("SignInPanel", () => {
	beforeEach(() => {
		appleAuthenticationFns.isAvailableAsync.mockReset();
		appleAuthenticationFns.isAvailableAsync.mockResolvedValue(true);
		authFns.authConfig.appleAuthAvailable = true;
		authFns.authConfig.googleAuthAvailable = true;
		authFns.authConfig.workosAuthAvailable = true;
		authFns.requestEmailCode.mockReset();
		authFns.requestEmailCode.mockResolvedValue(undefined);
		authFns.verifyEmailCode.mockReset();
		authFns.verifyEmailCode.mockResolvedValue(undefined);
		authFns.signInWithApple.mockReset();
		authFns.signInWithApple.mockResolvedValue(undefined);
		authFns.signInWithGoogle.mockReset();
		authFns.signInWithGoogle.mockResolvedValue(undefined);
		authFns.signInWithSso.mockReset();
		authFns.signInWithSso.mockResolvedValue(undefined);
	});

	it("renders the Cap web login surface", async () => {
		const tree = await renderTree(React.createElement(SignInPanel));
		const text = getTextNodes(tree);

		expect(text).toContain("Sign in to Cap");
		expect(text).toContain("Your videos, organized and ready to share.");
		expect(hasProp(tree, "viewBox", "0 0 40 40")).toBe(true);
		expect(hasProp(tree, "rx", 8)).toBe(true);
		expect(hasProp(tree, "placeholder", "tim@apple.com")).toBe(true);
		expect(hasProp(tree, "accessibilityLabel", "Email address")).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Enter your email to request a verification code",
			),
		).toBe(true);
		expect(hasProp(tree, "clearButtonMode", "while-editing")).toBe(true);
		expect(hasProp(tree, "enablesReturnKeyAutomatically", true)).toBe(true);
		expect(hasProp(tree, "selectionColor", "#0090ff")).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Enter a valid email address to continue",
			),
		).toBe(true);
		expect(text).toContain("Login with email");
		expect(text).toContain("Sign up here");
		expect(
			hasProp(tree, "accessibilityHint", "Opens sign up in a browser sheet"),
		).toBe(true);
		expect(hasProp(tree, "accessibilityRole", "link")).toBe(true);
		expect(text).toContain("OR");
		expect(text).toContain("Sign in with Apple");
		expect(text).toContain("Login with Google");
		expect(text).toContain("Login with SAML SSO");
		expect(text).toContain("Terms of Service");
		expect(text).toContain("Privacy Policy");
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Opens Terms of Service in a browser sheet",
			),
		).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Opens Privacy Policy in a browser sheet",
			),
		).toBe(true);
	});

	it("hides unavailable provider options", async () => {
		authFns.authConfig.appleAuthAvailable = false;
		authFns.authConfig.googleAuthAvailable = false;
		authFns.authConfig.workosAuthAvailable = false;

		const tree = await renderTree(React.createElement(SignInPanel));
		const text = getTextNodes(tree);

		expect(text).toContain("Login with email");
		expect(text).not.toContain("OR");
		expect(text).not.toContain("Sign in with Apple");
		expect(text).not.toContain("Login with Google");
		expect(text).not.toContain("Login with SAML SSO");
	});

	it("hides Apple sign in when native authentication is unavailable", async () => {
		appleAuthenticationFns.isAvailableAsync.mockResolvedValueOnce(false);

		const tree = await renderTree(React.createElement(SignInPanel));
		const text = getTextNodes(tree);

		expect(text).not.toContain("Sign in with Apple");
		expect(text).toContain("Login with Google");
		expect(text).toContain("Login with SAML SSO");
	});

	it("shows the native SSO organization step", async () => {
		const renderer = await renderPanel();
		const [ssoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with SAML SSO",
		});
		if (!ssoButton) throw new Error("SSO button was not rendered");

		await act(async () => {
			ssoButton.props.onPress();
		});

		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(hasProp(tree, "placeholder", "Enter your Organization ID...")).toBe(
			true,
		);
		expect(hasProp(tree, "accessibilityLabel", "Organization ID")).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Enter your organization ID to continue with SSO",
			),
		).toBe(true);
		expect(hasProp(tree, "clearButtonMode", "while-editing")).toBe(true);
		expect(hasProp(tree, "selectionColor", "#0090ff")).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityHint",
				"Enter your organization ID to continue",
			),
		).toBe(true);
		const [continueButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Continue with SSO",
		});
		expect(continueButton?.props.accessibilityValue).toEqual({
			text: "Organization ID required",
		});
		expect(text).toContain("Continue with SSO");
		expect(text).toContain("Back");
	});

	it("locks the SSO back button while starting sign in", async () => {
		let resolveSso: (() => void) | null = null;
		authFns.signInWithSso.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveSso = resolve;
				}),
		);
		const renderer = await renderPanel();
		const [ssoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with SAML SSO",
		});
		if (!ssoButton) throw new Error("SSO button was not rendered");

		await act(async () => {
			ssoButton.props.onPress();
		});

		const [organizationInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization ID",
		});
		if (!organizationInput)
			throw new Error("Organization ID input was not rendered");
		await act(async () => {
			organizationInput.props.onChangeText("acme");
		});

		const [continueButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Continue with SSO",
		});
		if (!continueButton)
			throw new Error("SSO continue button was not rendered");
		expect(continueButton.props.accessibilityHint).toBe(
			"Starts SAML SSO for this organization",
		);
		await act(async () => {
			void continueButton.props.onPress();
			await Promise.resolve();
		});

		const [loadingBackButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Back",
		});
		const [loadingOrganizationInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization ID",
		});
		const [loadingContinueButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Continue with SSO",
		});
		expect(loadingBackButton?.props.disabled).toBe(true);
		expect(loadingBackButton?.props.accessibilityState).toEqual({
			disabled: true,
		});
		expect(loadingBackButton?.props.accessibilityHint).toBe(
			"Sign in is in progress",
		);
		expect(loadingBackButton?.props.accessibilityValue).toEqual({
			text: "Starting SAML SSO sign in",
		});
		expect(loadingOrganizationInput?.props.editable).toBe(false);
		expect(loadingOrganizationInput?.props.accessibilityState).toEqual({
			disabled: true,
		});
		expect(loadingOrganizationInput?.props.accessibilityValue).toEqual({
			text: "Starting SAML SSO sign in",
		});
		expect(loadingContinueButton?.props.accessibilityHint).toBe(
			"SAML SSO sign in is starting",
		);
		expect(loadingContinueButton?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loadingContinueButton?.props.accessibilityValue).toEqual({
			text: "Starting SAML SSO sign in",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Continue with SSO");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Starting SSO...");

		await act(async () => {
			organizationInput.props.onChangeText("changed");
		});

		const [unchangedOrganizationInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization ID",
		});
		expect(unchangedOrganizationInput?.props.value).toBe("acme");

		await act(async () => {
			resolveSso?.();
			await Promise.resolve();
		});
	});

	it("does not request an email code for an invalid email address", async () => {
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie");
		});
		expect(emailButton.props.accessibilityHint).toBe(
			"Enter a valid email address to continue",
		);
		const [invalidEmailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		expect(invalidEmailButton?.props.accessibilityValue).toEqual({
			text: "Email address is not valid",
		});
		expect(emailButton.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		expect(authFns.requestEmailCode).not.toHaveBeenCalled();
	});

	it("locks the email field while requesting a verification code", async () => {
		let resolveRequest: (() => void) | null = null;
		authFns.requestEmailCode.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveRequest = resolve;
				}),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			void emailButton.props.onPress();
			await Promise.resolve();
		});

		const [loadingEmailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [loadingEmailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		expect(loadingEmailInput?.props.editable).toBe(false);
		expect(loadingEmailInput?.props.accessibilityState).toEqual({
			disabled: true,
		});
		expect(loadingEmailInput?.props.accessibilityValue).toEqual({
			text: "Sending verification code",
		});
		expect(loadingEmailButton?.props.accessibilityHint).toBe(
			"Sending verification code",
		);
		expect(loadingEmailButton?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loadingEmailButton?.props.accessibilityValue).toEqual({
			text: "Sending verification code",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Login with email");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Sending...");

		await act(async () => {
			emailInput.props.onChangeText("changed@cap.so");
		});

		const [unchangedEmailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		expect(unchangedEmailInput?.props.value).toBe("richie@cap.so");

		await act(async () => {
			resolveRequest?.();
			await Promise.resolve();
		});
	});

	it("locks browser links while requesting a verification code", async () => {
		let resolveRequest: (() => void) | null = null;
		authFns.requestEmailCode.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveRequest = resolve;
				}),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			void emailButton.props.onPress();
			await Promise.resolve();
		});

		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		openBrowserAsync.mockClear();
		const [signupLink, termsLink, privacyLink] = renderer.root.findAllByProps({
			accessibilityRole: "link",
		});
		if (!signupLink || !termsLink || !privacyLink) {
			throw new Error("Browser links were not rendered");
		}

		expect(signupLink.props.accessibilityState).toEqual({ disabled: true });
		expect(signupLink.props.accessibilityHint).toBe("Sign in is in progress");
		expect(signupLink.props.accessibilityValue).toEqual({
			text: "Sending verification code",
		});
		expect(termsLink.props.accessibilityState).toEqual({ disabled: true });
		expect(termsLink.props.accessibilityHint).toBe("Sign in is in progress");
		expect(termsLink.props.accessibilityValue).toEqual({
			text: "Sending verification code",
		});
		expect(privacyLink.props.accessibilityState).toEqual({ disabled: true });
		expect(privacyLink.props.accessibilityHint).toBe("Sign in is in progress");
		expect(privacyLink.props.accessibilityValue).toEqual({
			text: "Sending verification code",
		});

		await act(async () => {
			signupLink.props.onPress();
			termsLink.props.onPress();
			privacyLink.props.onPress();
		});

		expect(openBrowserAsync).not.toHaveBeenCalled();

		await act(async () => {
			resolveRequest?.();
			await Promise.resolve();
		});
	});

	it("deduplicates sign-in actions while a provider request is pending", async () => {
		let resolveGoogle: (() => void) | null = null;
		authFns.signInWithGoogle.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveGoogle = resolve;
				}),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		if (!emailInput) throw new Error("Email input was not rendered");

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});

		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		const [appleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign in with Apple",
		});
		const [googleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with Google",
		});
		const [ssoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with SAML SSO",
		});
		const [signupLink] = renderer.root.findAllByProps({
			accessibilityHint: "Opens sign up in a browser sheet",
		});
		const [termsLink] = renderer.root.findAllByProps({
			accessibilityHint: "Opens Terms of Service in a browser sheet",
		});
		const [privacyLink] = renderer.root.findAllByProps({
			accessibilityHint: "Opens Privacy Policy in a browser sheet",
		});
		if (
			!emailButton ||
			!appleButton ||
			!googleButton ||
			!ssoButton ||
			!signupLink ||
			!termsLink ||
			!privacyLink
		) {
			throw new Error("Sign-in actions were not rendered");
		}

		await act(async () => {
			void googleButton.props.onPress();
			await Promise.resolve();
		});

		const [loadingEmailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		const [loadingGoogleButton] = renderer.root.findAll(
			(node) =>
				node.props.accessibilityLabel === "Login with Google" &&
				node.props.accessibilityHint === "Google sign in is starting",
		);
		const [loadingSsoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with SAML SSO",
		});
		const [loadingAppleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign in with Apple",
		});
		expect(loadingAppleButton?.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		expect(loadingAppleButton?.props.accessibilityValue).toEqual({
			text: "Starting Google sign in",
		});
		expect(loadingEmailButton?.props.disabled).toBe(true);
		expect(loadingEmailButton?.props.accessibilityHint).toBe(
			"Sign in is in progress",
		);
		expect(loadingEmailButton?.props.accessibilityValue).toEqual({
			text: "Starting Google sign in",
		});
		expect(loadingGoogleButton?.props.accessibilityHint).toBe(
			"Google sign in is starting",
		);
		expect(loadingGoogleButton?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loadingGoogleButton?.props.accessibilityValue).toEqual({
			text: "Starting Google sign in",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Login with Google");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Starting Google...");
		expect(loadingSsoButton?.props.disabled).toBe(true);
		expect(loadingSsoButton?.props.accessibilityHint).toBe(
			"Sign in is in progress",
		);
		expect(loadingSsoButton?.props.accessibilityValue).toEqual({
			text: "Starting Google sign in",
		});

		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		openBrowserAsync.mockClear();

		await act(async () => {
			appleButton.props.onPress();
			googleButton.props.onPress();
			emailButton.props.onPress();
			ssoButton.props.onPress();
			signupLink.props.onPress();
			termsLink.props.onPress();
			privacyLink.props.onPress();
			await Promise.resolve();
		});

		expect(authFns.signInWithApple).not.toHaveBeenCalled();
		expect(authFns.signInWithGoogle).toHaveBeenCalledTimes(1);
		expect(authFns.requestEmailCode).not.toHaveBeenCalled();
		expect(openBrowserAsync).not.toHaveBeenCalled();
		expect(getTextNodes(renderer.toJSON())).not.toContain("Continue with SSO");

		await act(async () => {
			resolveGoogle?.();
			await Promise.resolve();
		});
	});

	it("marks a failed Google sign-in as retryable", async () => {
		authFns.signInWithGoogle.mockRejectedValueOnce(
			new Error("Google unavailable"),
		);
		const renderer = await renderPanel();
		const [googleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with Google",
		});
		if (!googleButton) throw new Error("Google button was not rendered");

		await act(async () => {
			await googleButton.props.onPress();
		});

		expect(getTextNodes(renderer.toJSON())).toContain("Google unavailable");
		const [retryGoogleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Retry Google sign in",
		});
		const [errorAlert] = renderer.root.findAllByProps({
			accessibilityRole: "alert",
		});
		expect(retryGoogleButton?.props.accessibilityHint).toBe(
			"Google unavailable",
		);
		expect(retryGoogleButton?.props.accessibilityValue).toEqual({
			text: "Google unavailable",
		});
		expect(errorAlert?.props.accessibilityLabel).toBe(
			"Sign-in error: Google unavailable",
		);

		await act(async () => {
			await retryGoogleButton?.props.onPress();
		});

		expect(authFns.signInWithGoogle).toHaveBeenCalledTimes(2);
		expect(getTextNodes(renderer.toJSON())).not.toContain("Google unavailable");
		expect(
			renderer.root.findAllByProps({
				accessibilityLabel: "Retry Google sign in",
			}),
		).toHaveLength(0);
	});

	it("keeps a failed Apple sign-in retryable on the system button", async () => {
		authFns.signInWithApple.mockRejectedValueOnce(
			new Error("Apple unavailable"),
		);
		const renderer = await renderPanel();
		const [appleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign in with Apple",
		});
		if (!appleButton) throw new Error("Apple button was not rendered");

		await act(async () => {
			await appleButton.props.onPress();
		});

		expect(getTextNodes(renderer.toJSON())).toContain("Apple unavailable");
		const [retryAppleButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Sign in with Apple",
		});
		expect(retryAppleButton?.props.accessibilityHint).toBe("Apple unavailable");
		expect(retryAppleButton?.props.accessibilityValue).toEqual({
			text: "Apple unavailable",
		});

		await act(async () => {
			await retryAppleButton?.props.onPress();
		});

		expect(authFns.signInWithApple).toHaveBeenCalledTimes(2);
		expect(getTextNodes(renderer.toJSON())).not.toContain("Apple unavailable");
	});

	it("marks a failed SSO sign-in on the organization step", async () => {
		authFns.signInWithSso.mockRejectedValueOnce(new Error("SSO unavailable"));
		const renderer = await renderPanel();
		const [ssoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with SAML SSO",
		});
		if (!ssoButton) throw new Error("SSO button was not rendered");

		await act(async () => {
			ssoButton.props.onPress();
		});

		const [organizationInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization ID",
		});
		if (!organizationInput)
			throw new Error("Organization ID input was not rendered");
		await act(async () => {
			organizationInput.props.onChangeText("acme");
		});

		const [continueButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Continue with SSO",
		});
		if (!continueButton)
			throw new Error("SSO continue button was not rendered");
		await act(async () => {
			await continueButton.props.onPress();
		});

		expect(getTextNodes(renderer.toJSON())).toContain("SSO unavailable");
		const [organizationInputAfterError] = renderer.root.findAllByProps({
			accessibilityLabel: "Organization ID",
		});
		const [retrySsoButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Retry SAML SSO sign in",
		});
		const [errorAlert] = renderer.root.findAllByProps({
			accessibilityRole: "alert",
		});
		expect(organizationInputAfterError?.props.accessibilityHint).toBe(
			"SSO unavailable",
		);
		expect(retrySsoButton?.props.accessibilityHint).toBe("SSO unavailable");
		expect(retrySsoButton?.props.accessibilityValue).toEqual({
			text: "SSO unavailable",
		});
		expect(errorAlert?.props.accessibilityLabel).toBe(
			"Sign-in error: SSO unavailable",
		);
		expect(
			hasStyle(renderer.toJSON(), {
				borderColor: "#f4a9aa",
			}),
		).toBe(true);

		await act(async () => {
			await retrySsoButton?.props.onPress();
		});

		expect(authFns.signInWithSso).toHaveBeenCalledTimes(2);
		expect(getTextNodes(renderer.toJSON())).not.toContain("SSO unavailable");
		expect(
			renderer.root.findAllByProps({
				accessibilityLabel: "Retry SAML SSO sign in",
			}),
		).toHaveLength(0);
	});

	it("shows the right error when an email is not allowed", async () => {
		const { MobileApiError } = await import("@/api/mobile");
		authFns.requestEmailCode.mockRejectedValueOnce(
			new MobileApiError("Forbidden", 403, null),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("blocked@example.com");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		expect(getTextNodes(renderer.toJSON())).toContain(
			"This email cannot be used to sign in to Cap.",
		);
		const [emailInputAfterError] = renderer.root.findAllByProps({
			accessibilityLabel: "Email address",
		});
		const [errorAlert] = renderer.root.findAllByProps({
			accessibilityRole: "alert",
		});
		expect(emailInputAfterError?.props.accessibilityHint).toBe(
			"This email cannot be used to sign in to Cap.",
		);
		const [emailButtonAfterError] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		expect(emailButtonAfterError?.props.accessibilityValue).toEqual({
			text: "This email cannot be used to sign in to Cap.",
		});
		expect(errorAlert?.props.accessibilityLabel).toBe(
			"Sign-in error: This email cannot be used to sign in to Cap.",
		);
		expect(errorAlert?.props.accessibilityLiveRegion).toBe("polite");
		expect(
			hasStyle(renderer.toJSON(), {
				borderColor: "#f4a9aa",
			}),
		).toBe(true);
		expect(
			hasStyle(renderer.toJSON(), {
				backgroundColor: "#fffcfc",
				borderColor: "#fdbdbe",
			}),
		).toBe(true);
	});

	it("switches to a web-like verification code step after requesting email", async () => {
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(authFns.requestEmailCode).toHaveBeenCalledWith("richie@cap.so");
		expect(text).toContain("Back");
		expect(text).toContain("Enter verification code");
		expect(text).toContain("We sent a 6-digit code to richie@cap.so");
		expect(text).toContain("Verify Code");
		expect(text).toContain("Resend in 30s");
		expect(text).toContain("Terms of Service");
		expect(hasProp(tree, "accessibilityLabel", "Verification code")).toBe(true);
		const [codeTarget] = renderer.root.findAllByProps({
			accessibilityLabel: "Verification code",
		});
		const [verifyButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Verify Code",
		});
		const [resendButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Resend in 30s",
		});
		const [codeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		if (!codeInput) throw new Error("One-time code input was not rendered");
		expect(codeTarget?.props.accessibilityValue).toEqual({
			text: "0 of 6 digits entered",
		});
		expect(verifyButton?.props.accessibilityValue).toEqual({
			text: "0 of 6 digits entered",
		});
		expect(resolveStyle(verifyButton?.props.style)).toMatchObject({
			backgroundColor: "#d9d9d9",
			borderColor: "#d9d9d9",
		});
		expect(resendButton?.props.accessibilityValue).toEqual({
			text: "Wait 30 seconds",
		});
		expect(hasStyle(tree, { gap: 20, paddingTop: 2 })).toBe(true);
		expect(
			hasProp(tree, "accessibilityHint", "Tap to enter the 6-digit code"),
		).toBe(true);
		expect(
			hasProp(tree, "accessibilityHint", "Enter the 6-digit code to continue"),
		).toBe(true);
		expect(hasProp(tree, "accessibilityHint", "Returns to email sign in")).toBe(
			true,
		);
		expect(hasProp(tree, "accessibilityElementsHidden", true)).toBe(true);
		expect(hasProp(tree, "accessible", false)).toBe(true);
		expect(
			hasProp(tree, "importantForAccessibility", "no-hide-descendants"),
		).toBe(true);
		expect(hasProp(tree, "selectionColor", "#0090ff")).toBe(true);
		await act(async () => {
			codeInput.props.onFocus();
		});
		expect(
			hasStyle(renderer.toJSON(), {
				backgroundColor: "#f9f9f9",
				borderColor: "#0090ff",
				shadowOpacity: 0.12,
			}),
		).toBe(true);
		await act(async () => {
			codeInput.props.onBlur();
		});
		expect(
			hasStyle(renderer.toJSON(), {
				backgroundColor: "#f9f9f9",
				borderColor: "#0090ff",
				shadowOpacity: 0.12,
			}),
		).toBe(false);
		expect(text).not.toContain("Sign in with Apple");
		expect(text).not.toContain("Login with Google");
	});

	it("verifies an autofilled one-time code when all six digits are entered", async () => {
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const [codeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		if (!codeInput) throw new Error("One-time code input was not rendered");

		await act(async () => {
			codeInput.props.onChangeText("123-456");
			await Promise.resolve();
		});

		expect(authFns.verifyEmailCode).toHaveBeenCalledWith(
			"richie@cap.so",
			"123456",
		);
	});

	it("marks invalid verification codes on the visible code target", async () => {
		const { MobileApiError } = await import("@/api/mobile");
		authFns.verifyEmailCode.mockRejectedValueOnce(
			new MobileApiError("Forbidden", 403, null),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const [codeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		if (!codeInput) throw new Error("One-time code input was not rendered");

		await act(async () => {
			codeInput.props.onChangeText("123456");
			await Promise.resolve();
		});

		expect(getTextNodes(renderer.toJSON())).toContain(
			"That code is invalid or expired.",
		);
		const [codeTarget] = renderer.root.findAllByProps({
			accessibilityLabel: "Verification code",
		});
		const [errorAlert] = renderer.root.findAllByProps({
			accessibilityRole: "alert",
		});
		expect(codeTarget?.props.accessibilityHint).toBe(
			"That code is invalid or expired.",
		);
		expect(codeTarget?.props.accessibilityValue).toEqual({
			text: "0 of 6 digits entered",
		});
		expect(errorAlert?.props.accessibilityLabel).toBe(
			"Sign-in error: That code is invalid or expired.",
		);
		expect(
			hasStyle(renderer.toJSON(), {
				backgroundColor: "#fffcfc",
				borderColor: "#f4a9aa",
			}),
		).toBe(true);
	});

	it("locks the visible code entry target while verifying", async () => {
		let resolveVerify: (() => void) | null = null;
		authFns.verifyEmailCode.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveVerify = resolve;
				}),
		);
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const [codeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		if (!codeInput) throw new Error("One-time code input was not rendered");

		await act(async () => {
			codeInput.props.onChangeText("123456");
			await Promise.resolve();
		});

		const [codeTarget] = renderer.root.findAllByProps({
			accessibilityLabel: "Verification code",
		});
		const [loadingBackButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Back",
		});
		const [loadingCodeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		const [loadingVerifyButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Verify Code",
		});
		expect(codeTarget?.props.disabled).toBe(true);
		expect(codeTarget?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(codeTarget?.props.accessibilityHint).toBe("Verifying code");
		expect(codeTarget?.props.accessibilityValue).toEqual({
			text: "Verifying code",
		});
		expect(loadingBackButton?.props.accessibilityHint).toBe(
			"Sign in is in progress",
		);
		expect(loadingBackButton?.props.accessibilityValue).toEqual({
			text: "Verifying code",
		});
		expect(loadingCodeInput?.props.editable).toBe(false);
		expect(loadingVerifyButton?.props.accessibilityHint).toBe("Verifying code");
		expect(loadingVerifyButton?.props.accessibilityValue).toEqual({
			text: "Verifying code",
		});
		expect(loadingVerifyButton?.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(getTextNodes(renderer.toJSON())).not.toContain("Verifying...");

		await act(async () => {
			codeInput.props.onChangeText("654321");
			await Promise.resolve();
		});

		const [unchangedCodeInput] = renderer.root.findAllByProps({
			textContentType: "oneTimeCode",
		});
		expect(unchangedCodeInput?.props.value).toBe("123456");
		expect(authFns.verifyEmailCode).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveVerify?.();
			await Promise.resolve();
		});
	});

	it("prevents repeated email code requests during the resend cooldown", async () => {
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("richie@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const [resendButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Resend in 30s",
		});
		if (!resendButton) throw new Error("Resend control was not rendered");

		expect(resendButton.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		expect(resendButton.props.accessibilityHint).toBe(
			"Wait 30 seconds before requesting a new code",
		);
		expect(resendButton.props.accessibilityValue).toEqual({
			text: "Wait 30 seconds",
		});
		expect(resendButton.props.hitSlop).toBe(6);
		expect(
			hasStyle(renderer.toJSON(), {
				color: "#8d8d8d",
				textDecorationLine: "none",
			}),
		).toBe(true);

		await act(async () => {
			await resendButton.props.onPress();
		});

		expect(authFns.requestEmailCode).toHaveBeenCalledTimes(1);
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Please wait 30 seconds before requesting a new code.",
		);
	});

	it("allows a corrected email to request a code without waiting for the previous cooldown", async () => {
		const renderer = await renderPanel();
		const [emailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [emailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!emailInput || !emailButton) {
			throw new Error("Email sign in controls were not rendered");
		}

		await act(async () => {
			emailInput.props.onChangeText("wrong@cap.so");
		});
		await act(async () => {
			await emailButton.props.onPress();
		});

		const [backButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Back",
		});
		if (!backButton) throw new Error("Back button was not rendered");

		await act(async () => {
			backButton.props.onPress();
		});

		const [correctedEmailInput] = renderer.root.findAllByProps({
			placeholder: "tim@apple.com",
		});
		const [correctedEmailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		if (!correctedEmailInput || !correctedEmailButton) {
			throw new Error("Corrected email sign in controls were not rendered");
		}

		await act(async () => {
			correctedEmailInput.props.onChangeText("right@cap.so");
		});

		const [readyEmailButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Login with email",
		});
		expect(readyEmailButton?.props.accessibilityState).toEqual({
			busy: false,
			disabled: false,
		});

		await act(async () => {
			await readyEmailButton?.props.onPress();
		});

		expect(authFns.requestEmailCode).toHaveBeenNthCalledWith(1, "wrong@cap.so");
		expect(authFns.requestEmailCode).toHaveBeenNthCalledWith(2, "right@cap.so");
	});
});
