import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoomImportScreen, { isLoomShareUrl } from "../../app/loom-import";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		client: { importLoom: vi.fn() },
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
	});
	return renderer as unknown as ReactTestRenderer;
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);
	return {
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

vi.mock("expo-clipboard", () => ({
	getStringAsync: vi.fn(() => Promise.resolve("")),
}));

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		router: { replace: vi.fn() },
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

describe("LoomImportScreen", () => {
	beforeEach(() => {
		auth.value.client.importLoom.mockReset();
		auth.value.client.importLoom.mockResolvedValue({
			id: "video_456",
			shareUrl: "https://cap.so/s/video_456",
		});
		auth.value.refresh.mockReset();
		auth.value.refresh.mockResolvedValue(undefined);
	});

	it("accepts only genuine HTTPS Loom video links", () => {
		expect(isLoomShareUrl("https://www.loom.com/share/abcdefghij")).toBe(true);
		expect(isLoomShareUrl("https://loom.com.evil/share/abcdefghij")).toBe(
			false,
		);
		expect(isLoomShareUrl("https://www.loom.com/share/short")).toBe(false);
	});

	it("starts the server import and opens the new Cap", async () => {
		const renderer = await renderComponent(
			React.createElement(LoomImportScreen),
		);
		const [input] = renderer.root.findAllByProps({
			accessibilityLabel: "Loom share link",
		});
		if (!input) throw new Error("Loom input was not rendered");

		await act(async () => {
			input.props.onChangeText("https://www.loom.com/share/abcdefghij");
		});
		const [button] = renderer.root.findAllByProps({
			accessibilityLabel: "Import video",
		});
		if (!button) throw new Error("Import button was not rendered");

		await act(async () => {
			button.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const { router } = await import("expo-router");
		expect(auth.value.client.importLoom).toHaveBeenCalledWith(
			"https://www.loom.com/share/abcdefghij",
		);
		expect(router.replace).toHaveBeenCalledWith({
			pathname: "/caps/[id]",
			params: { id: "video_456" },
		});
	});

	it("opens the imported Cap even when account refresh fails", async () => {
		auth.value.refresh.mockRejectedValueOnce(new Error("Refresh unavailable"));
		const renderer = await renderComponent(
			React.createElement(LoomImportScreen),
		);
		const [input] = renderer.root.findAllByProps({
			accessibilityLabel: "Loom share link",
		});
		if (!input) throw new Error("Loom input was not rendered");

		await act(async () => {
			input.props.onChangeText("https://www.loom.com/share/abcdefghij");
		});
		const [button] = renderer.root.findAllByProps({
			accessibilityLabel: "Import video",
		});
		if (!button) throw new Error("Import button was not rendered");

		await act(async () => {
			button.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const { router } = await import("expo-router");
		expect(router.replace).toHaveBeenCalledWith({
			pathname: "/caps/[id]",
			params: { id: "video_456" },
		});
	});

	it("describes Pro access without an external purchase call to action", async () => {
		const { MobileApiError } = await import("@/api/mobile");
		auth.value.client.importLoom.mockRejectedValueOnce(
			new MobileApiError("Forbidden", 403, null),
		);
		const renderer = await renderComponent(
			React.createElement(LoomImportScreen),
		);
		const [input] = renderer.root.findAllByProps({
			accessibilityLabel: "Loom share link",
		});
		if (!input) throw new Error("Loom input was not rendered");

		await act(async () => {
			input.props.onChangeText("https://www.loom.com/share/abcdefghij");
		});
		const [button] = renderer.root.findAllByProps({
			accessibilityLabel: "Import video",
		});
		if (!button) throw new Error("Import button was not rendered");

		await act(async () => {
			button.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const text = JSON.stringify(renderer.toJSON());
		expect(text).toContain(
			"Loom import is available on Cap Pro. Your current plan does not include this feature.",
		);
		expect(text).not.toContain("Upgrade on the web");
	});
});
