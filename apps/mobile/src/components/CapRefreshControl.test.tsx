import type { ReactElement, ReactNode } from "react";
import { RefreshControl } from "react-native";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { CapRefreshControl, CapRefreshOverlay } from "./CapRefreshControl";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

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
		Platform: { OS: "ios" },
		RefreshControl: createHost("RefreshControl"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
		},
	};
});

vi.mock("react-native-reanimated", async () => {
	const React = await import("react");
	return {
		default: {
			View: ({ children, ...props }: HostProps) =>
				React.createElement("Animated.View", props, children),
		},
		FadeIn: { duration: () => ({}) },
		FadeOut: { duration: () => ({}) },
	};
});

vi.mock("./CapLoadingIndicator", async () => {
	const React = await import("react");
	return {
		CapLoadingIndicator: (props: HostProps) =>
			React.createElement("CapLoadingIndicator", props),
	};
});

describe("CapRefreshControl", () => {
	it("hides the native iOS spinner so the Cap overlay can replace it", async () => {
		const onRefresh = vi.fn();
		const renderer = await renderComponent(
			<CapRefreshControl refreshing onRefresh={onRefresh} />,
		);
		const refreshControl = renderer.root.findByType(RefreshControl);

		expect(refreshControl.props).toMatchObject({
			onRefresh,
			refreshing: true,
			tintColor: "transparent",
		});
	});
});

describe("CapRefreshOverlay", () => {
	it("shows the compact Cap loader while refreshing", async () => {
		const renderer = await renderComponent(<CapRefreshOverlay refreshing />);
		const loader = renderer.root.findByProps({ size: 32 });

		expect(loader.props).toMatchObject({ size: 32 });
	});

	it("renders nothing when not refreshing", async () => {
		const renderer = await renderComponent(
			<CapRefreshOverlay refreshing={false} />,
		);

		expect(renderer.toJSON()).toBeNull();
	});
});
