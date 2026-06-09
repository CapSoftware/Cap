import type { ReactElement, ReactNode } from "react";
import { RefreshControl } from "react-native";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { CapRefreshControl } from "./CapRefreshControl";

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
		RefreshControl: createHost("RefreshControl"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
		},
	};
});

describe("CapRefreshControl", () => {
	it("uses Cap web colors for native pull-to-refresh", async () => {
		const onRefresh = vi.fn();
		const renderer = await renderComponent(
			<CapRefreshControl refreshing onRefresh={onRefresh} />,
		);
		const refreshControl = renderer.root.findByType(RefreshControl);

		expect(refreshControl.props).toMatchObject({
			colors: ["#0d74ce"],
			onRefresh,
			progressBackgroundColor: "#fcfcfc",
			refreshing: true,
			tintColor: "#0d74ce",
		});
	});
});
