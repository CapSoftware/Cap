import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeleteAccountScreen from "../../app/delete-account";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		client: {
			requestAccountDeletion: vi.fn(() =>
				Promise.resolve({ success: true as const }),
			),
		},
		signOut: vi.fn(() => Promise.resolve()),
	},
}));

const actionSheet = vi.hoisted(() => ({
	showActionSheetWithOptions: vi.fn(),
}));

const router = vi.hoisted(() => ({
	replace: vi.fn(),
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

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		router,
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

describe("DeleteAccountScreen", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		auth.value.client.requestAccountDeletion.mockResolvedValue({
			success: true,
		});
		auth.value.signOut.mockResolvedValue(undefined);
	});

	it("discloses permanent deletion and requires the confirmation phrase", async () => {
		const renderer = await renderComponent(
			React.createElement(DeleteAccountScreen),
		);
		const text = getTextNodes(renderer.toJSON()).join(" ");
		const [confirmation] = renderer.root.findAllByProps({
			accessibilityLabel: "Deletion confirmation",
		});
		const [request] = renderer.root.findAllByProps({
			accessibilityLabel: "Request account deletion",
		});
		if (!confirmation || !request)
			throw new Error("Deletion controls were not rendered");

		expect(text).toContain("Permanently delete your account");
		expect(text).toContain("Within 30 days");
		expect(request.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});

		await act(async () => {
			confirmation.props.onChangeText("DELETE");
		});
		const [confirmedRequest] = renderer.root.findAllByProps({
			accessibilityLabel: "Request account deletion",
		});
		expect(confirmedRequest?.props.accessibilityState).toEqual({
			busy: false,
			disabled: false,
		});
	});

	it("submits after destructive confirmation and signs out", async () => {
		const renderer = await renderComponent(
			React.createElement(DeleteAccountScreen),
		);
		const [confirmation] = renderer.root.findAllByProps({
			accessibilityLabel: "Deletion confirmation",
		});
		if (!confirmation)
			throw new Error("Deletion confirmation was not rendered");

		await act(async () => {
			confirmation.props.onChangeText("DELETE");
		});
		const [request] = renderer.root.findAllByProps({
			accessibilityLabel: "Request account deletion",
		});
		if (!request) throw new Error("Deletion action was not rendered");
		await act(async () => {
			request.props.onPress();
		});

		expect(actionSheet.showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 1,
				destructiveButtonIndex: 0,
				options: ["Request permanent deletion", "Cancel"],
			}),
			expect.any(Function),
		);
		const callback = actionSheet.showActionSheetWithOptions.mock
			.calls[0]?.[1] as ((index: number) => void) | undefined;
		if (!callback)
			throw new Error("Deletion confirmation callback was not set");

		await act(async () => {
			callback(0);
			await flushMicrotasks();
		});

		expect(auth.value.client.requestAccountDeletion).toHaveBeenCalledTimes(1);
		expect(auth.value.signOut).toHaveBeenCalledTimes(1);
		expect(router.replace).toHaveBeenCalledWith("/(tabs)/account");
		const { Alert } = await import("react-native");
		expect(Alert.alert).toHaveBeenCalledWith(
			"Deletion request received",
			expect.stringContaining("within 30 days"),
		);
	});

	it("keeps the user signed in when the request fails", async () => {
		auth.value.client.requestAccountDeletion.mockRejectedValueOnce(
			new Error("offline"),
		);
		const renderer = await renderComponent(
			React.createElement(DeleteAccountScreen),
		);
		const [confirmation] = renderer.root.findAllByProps({
			accessibilityLabel: "Deletion confirmation",
		});
		if (!confirmation)
			throw new Error("Deletion confirmation was not rendered");
		await act(async () => {
			confirmation.props.onChangeText("DELETE");
		});
		const [request] = renderer.root.findAllByProps({
			accessibilityLabel: "Request account deletion",
		});
		if (!request) throw new Error("Deletion action was not rendered");
		await act(async () => {
			request.props.onPress();
		});
		const callback = actionSheet.showActionSheetWithOptions.mock
			.calls[0]?.[1] as ((index: number) => void) | undefined;
		if (!callback)
			throw new Error("Deletion confirmation callback was not set");

		await act(async () => {
			callback(0);
			await flushMicrotasks();
		});

		expect(auth.value.signOut).not.toHaveBeenCalled();
		expect(getTextNodes(renderer.toJSON()).join(" ")).toContain(
			"could not be submitted",
		);
	});
});
