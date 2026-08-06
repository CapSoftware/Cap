import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnalyticsScreen, { downsampleAnalyticsChart } from "../../app/analytics";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const auth = vi.hoisted(() => ({
	value: {
		status: "signedIn" as const,
		client: {
			getCapAnalytics: vi.fn(),
		},
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

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		Stack: {
			Screen: (props: HostProps) => React.createElement("StackScreen", props),
		},
		useLocalSearchParams: () => ({ capId: "video_123" }),
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: HostProps) => React.createElement("SymbolView", props),
	};
});

vi.mock("react-native-svg", async () => {
	const React = await import("react");
	return {
		default: ({ children, ...props }: HostProps) =>
			React.createElement("Svg", props, children),
		Path: (props: HostProps) => React.createElement("Path", props),
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

describe("AnalyticsScreen", () => {
	beforeEach(() => {
		auth.value.client.getCapAnalytics.mockReset();
		auth.value.client.getCapAnalytics.mockResolvedValue({
			available: true,
			data: {
				capName: "Launch review",
				counts: { caps: 1, views: 12, comments: 2, reactions: 3 },
				chart: [
					{
						bucket: "2026-07-21T12:00:00Z",
						caps: 0,
						views: 12,
						comments: 2,
						reactions: 3,
					},
				],
				breakdowns: {
					countries: [{ name: "United Kingdom", views: 8, percentage: 66.7 }],
					cities: [],
					browsers: [],
					operatingSystems: [],
					devices: [],
					topCaps: [],
				},
			},
		});
	});

	it("loads native Cap analytics on demand", async () => {
		const renderer = await renderComponent(
			React.createElement(AnalyticsScreen),
		);
		const text = getTextNodes(renderer.toJSON());

		expect(auth.value.client.getCapAnalytics).toHaveBeenCalledWith(
			"video_123",
			"7d",
		);
		expect(text).toContain("Launch review");
		expect(text).toContain("Views over time");
		expect(text).toContain("United Kingdom");
	});

	it("describes unavailable analytics without an external purchase call to action", async () => {
		auth.value.client.getCapAnalytics.mockResolvedValueOnce({
			available: false,
			data: null,
		});
		const renderer = await renderComponent(
			React.createElement(AnalyticsScreen),
		);
		const text = getTextNodes(renderer.toJSON()).join(" ");

		expect(text).toContain("Your current plan does not include analytics.");
		expect(text).not.toContain("Upgrade on the web");
	});

	it("bounds chart work by aggregating older buckets", () => {
		const points = Array.from({ length: 120 }, (_, index) => ({
			bucket: String(index),
			caps: 0,
			views: 1,
			comments: 0,
			reactions: 0,
		}));
		const sampled = downsampleAnalyticsChart(points, 48);

		expect(sampled.length).toBeLessThanOrEqual(48);
		expect(sampled.reduce((total, point) => total + point.views, 0)).toBe(120);
	});
});
