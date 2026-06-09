import type { ReactElement, ReactNode } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ActionButton } from "./ActionButton";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

const renderComponent = async (
	node: ReactElement,
): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return renderer as unknown as ReactTestRenderer;
};

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resolveStyle = (style: unknown): Record<string, unknown> => {
	const resolved =
		typeof style === "function" ? style({ pressed: false }) : style;
	const styles = Array.isArray(resolved) ? resolved : [resolved];
	return Object.assign({}, ...styles.filter(Boolean));
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		ActivityIndicator: createHost("ActivityIndicator"),
		Pressable: createHost("Pressable"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		View: createHost("View"),
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: Record<string, unknown>) =>
			React.createElement("SymbolView", props),
	};
});

describe("ActionButton", () => {
	it("matches the Cap web dark button surface and clips the inset highlight", async () => {
		const renderer = await renderComponent(
			<ActionButton
				label="Upload"
				onPress={vi.fn()}
				accessibilityHint="Opens upload options"
				symbol="square.and.arrow.up"
				variant="dark"
			/>,
		);
		const button = renderer.root.findByProps({
			accessibilityLabel: "Upload",
		});

		expect(button.props.android_ripple).toEqual({
			color: "rgba(18, 22, 31, 0.05)",
		});
		expect(button.props.hitSlop).toEqual({
			bottom: 4,
			left: 4,
			right: 4,
			top: 4,
		});
		expect(button.props.accessibilityState).toEqual({
			busy: false,
			disabled: false,
		});
		expect(button.props.accessibilityHint).toBe("Opens upload options");
		expect(resolveStyle(button.props.style)).toMatchObject({
			backgroundColor: "#202020",
			borderColor: "#202020",
			borderRadius: 999,
			height: 44,
			overflow: "hidden",
		});
	});

	it("uses the Cap web gray button token pair", async () => {
		const renderer = await renderComponent(
			<ActionButton label="Photos" onPress={vi.fn()} variant="gray" />,
		);
		const button = renderer.root.findByProps({
			accessibilityLabel: "Photos",
		});

		expect(resolveStyle(button.props.style)).toMatchObject({
			backgroundColor: "#e0e0e0",
			borderColor: "#bbbbbb",
		});
	});

	it("allows a specific native label while keeping short visible text", async () => {
		const renderer = await renderComponent(
			<ActionButton
				label="Retry"
				accessibilityLabel="Retry upload failed-upload.mp4"
				accessibilityValue={{ text: "Upload failed" }}
				onPress={vi.fn()}
				variant="secondary"
			/>,
		);
		const button = renderer.root.findByProps({
			accessibilityLabel: "Retry upload failed-upload.mp4",
		});

		expect(button.findByProps({ children: "Retry" }).props.children).toBe(
			"Retry",
		);
		expect(button.props.accessibilityValue).toEqual({
			text: "Upload failed",
		});
	});

	it("exposes native disabled and busy state while loading", async () => {
		const renderer = await renderComponent(
			<ActionButton label="Upload" loading onPress={vi.fn()} variant="blue" />,
		);
		const button = renderer.root.findByProps({
			accessibilityLabel: "Upload",
		});

		expect(button.props.disabled).toBe(true);
		expect(button.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
	});
});
