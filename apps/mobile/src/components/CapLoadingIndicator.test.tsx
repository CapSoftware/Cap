import type { ReactElement, ReactNode } from "react";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapLoadingIndicator } from "./CapLoadingIndicator";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const motion = vi.hoisted(() => ({ reduceMotion: false }));

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
		},
		View: createHost("View"),
	};
});

vi.mock("react-native-reanimated", async () => {
	const React = await import("react");
	return {
		default: {
			View: ({ children, ...props }: HostProps) =>
				React.createElement("Animated.View", props, children),
		},
		Easing: {
			back: () => (t: number) => t,
			in: (f: (t: number) => number) => f,
			inOut: (f: (t: number) => number) => f,
			linear: (t: number) => t,
			out: (f: (t: number) => number) => f,
			quad: (t: number) => t,
		},
		cancelAnimation: vi.fn(),
		useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
		useReducedMotion: () => motion.reduceMotion,
		useSharedValue: (value: unknown) => ({ value }),
		withDelay: vi.fn((_ms: number, animation: unknown) => animation),
		withRepeat: vi.fn((animation: unknown) => animation),
		withSequence: vi.fn((...steps: unknown[]) => steps[steps.length - 1]),
		withTiming: vi.fn((value: unknown) => value),
	};
});

const renderComponent = async (
	node: ReactElement,
): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return renderer as unknown as ReactTestRenderer;
};

const flattenStyle = (style: unknown): Record<string, unknown> =>
	Array.isArray(style)
		? Object.assign({}, ...style.filter(Boolean).map(flattenStyle))
		: ((style as Record<string, unknown>) ?? {});

describe("CapLoadingIndicator", () => {
	beforeEach(() => {
		motion.reduceMotion = false;
		vi.clearAllMocks();
	});

	it("renders the untouched Cap icon at splash-icon proportions", async () => {
		const renderer = await renderComponent(<CapLoadingIndicator size={64} />);

		const outer = flattenStyle(
			renderer.root.findByProps({ testID: "cap-loading-circle-outer" }).props
				.style,
		);
		const middle = flattenStyle(
			renderer.root.findByProps({ testID: "cap-loading-circle-middle" }).props
				.style,
		);
		const inner = flattenStyle(
			renderer.root.findByProps({ testID: "cap-loading-circle-inner" }).props
				.style,
		);

		expect(outer).toMatchObject({ backgroundColor: "#4785FF", width: 64 });
		expect(middle).toMatchObject({
			backgroundColor: "#ADC9FF",
			width: 64 * (202 / 248),
		});
		expect(inner).toMatchObject({
			backgroundColor: "#ffffff",
			width: 64 * (156 / 248),
		});
	});

	it("rocks around the ball's bottom edge and announces itself as loading", async () => {
		const renderer = await renderComponent(<CapLoadingIndicator />);
		const wrapper = renderer.root.findByProps({
			testID: "cap-loading-indicator",
		});
		const ball = flattenStyle(
			renderer.root.findByProps({ testID: "cap-loading-ball" }).props.style,
		);
		const transform = ball.transform as Array<Record<string, unknown>>;

		expect(wrapper.props).toMatchObject({
			accessibilityLabel: "Loading",
			accessibilityRole: "progressbar",
		});
		expect(transform).toEqual([
			{ translateY: 28 },
			{ rotate: "0deg" },
			{ translateY: -28 },
			{ scale: 1 },
		]);
	});

	it("runs the rock and swell loops forever and cancels them on unmount", async () => {
		const reanimated = await import("react-native-reanimated");
		const renderer = await renderComponent(<CapLoadingIndicator />);
		const repeatMock = vi.mocked(reanimated.withRepeat).mock;

		expect(repeatMock.calls).toHaveLength(2);
		expect(repeatMock.calls.every((call) => call[1] === -1)).toBe(true);

		await act(async () => {
			renderer.unmount();
		});
		expect(reanimated.cancelAnimation).toHaveBeenCalled();
	});

	it("swaps the wobble for an opacity pulse when the system prefers reduced motion", async () => {
		motion.reduceMotion = true;
		const reanimated = await import("react-native-reanimated");
		const renderer = await renderComponent(<CapLoadingIndicator />);
		const ball = flattenStyle(
			renderer.root.findByProps({ testID: "cap-loading-ball" }).props.style,
		);

		expect(reanimated.withRepeat).toHaveBeenCalledWith(1, -1);
		expect(ball.transform).toEqual([]);
		expect(ball.opacity).toBeCloseTo(0.85);
	});
});
