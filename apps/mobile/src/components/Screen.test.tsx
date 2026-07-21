import type React from "react";
import TestRenderer, {
	act,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Screen } from "./Screen";

type HostProps = {
	children?: React.ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const renderTree = async (node?: React.ReactElement): Promise<JsonNode> => {
	let renderer: TestRenderer.ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(
			node ?? (
				<Screen
					title="Import"
					subtitle="Import videos from external sources."
				/>
			),
		);
	});
	return (renderer as TestRenderer.ReactTestRenderer | null)?.toJSON() ?? null;
};

const findTextByValue = (
	node: JsonNode,
	value: string,
): ReactTestRendererJSON | null => {
	if (!node || typeof node === "string") return null;
	if (Array.isArray(node)) {
		for (const item of node) {
			const match = findTextByValue(item, value);
			if (match) return match;
		}
		return null;
	}
	if (node.type === "Text" && node.children?.includes(value)) return node;
	for (const child of node.children ?? []) {
		const match = findTextByValue(child, value);
		if (match) return match;
	}
	return null;
};

const hasStyle = (
	node: JsonNode,
	expected: Record<string, unknown>,
): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some((item) => hasStyle(item, expected));
	const resolved = Array.isArray(node.props.style)
		? Object.assign({}, ...node.props.style.filter(Boolean))
		: node.props.style;
	if (
		resolved &&
		Object.entries(expected).every(([key, value]) => resolved[key] === value)
	) {
		return true;
	}
	return node.children?.some((child) => hasStyle(child, expected)) ?? false;
};

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		ActivityIndicator: createHost("ActivityIndicator"),
		RefreshControl: createHost("RefreshControl"),
		ScrollView: createHost("ScrollView"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
		},
		Text: createHost("Text"),
		View: createHost("View"),
	};
});

vi.mock("react-native-safe-area-context", async () => {
	const React = await import("react");
	return {
		SafeAreaView: ({ children, ...props }: HostProps) =>
			React.createElement("SafeAreaView", props, children),
	};
});

describe("Screen", () => {
	it("uses the Cap web subtitle scale", async () => {
		const tree = await renderTree();
		const subtitle = findTextByValue(
			tree,
			"Import videos from external sources.",
		);

		expect(subtitle?.props.style).toMatchObject({
			fontSize: 14,
			lineHeight: 20,
		});
		expect(hasStyle(tree, { paddingBottom: 32 })).toBe(true);
	});

	it("can keep focused inputs visible above the keyboard", async () => {
		const tree = await renderTree(
			<Screen automaticallyAdjustKeyboardInsets scroll />,
		);

		expect(tree).toMatchObject({
			type: "SafeAreaView",
			children: [
				{
					type: "ScrollView",
					props: { automaticallyAdjustKeyboardInsets: true },
				},
			],
		});
	});
});
