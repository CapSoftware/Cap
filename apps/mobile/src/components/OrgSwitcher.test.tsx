import { Organisation, User } from "@cap/web-domain";
import type { ReactElement, ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { MobileBootstrapResponse } from "@/api/mobile";
import { OrgSwitcher } from "./OrgSwitcher";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

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

const renderComponent = async (
	node: ReactElement,
): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return renderer as unknown as ReactTestRenderer;
};

const hasImageSourceUri = (node: JsonNode, uri: string): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node))
		return node.some((item) => hasImageSourceUri(item, uri));
	const source = node.props.source;
	if (
		source &&
		typeof source === "object" &&
		"uri" in source &&
		source.uri === uri
	) {
		return true;
	}
	return node.children?.some((child) => hasImageSourceUri(child, uri)) ?? false;
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

	return {
		ActionSheetIOS: {
			showActionSheetWithOptions: vi.fn(),
		},
		Modal: createHost("Modal"),
		Platform: {
			OS: "ios",
		},
		Pressable: createHost("Pressable"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		View: createHost("View"),
	};
});

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

const bootstrap: MobileBootstrapResponse = {
	user: {
		id: User.UserId.make("user_123"),
		name: "Richie",
		email: "richie@cap.so",
		imageUrl: null,
		activeOrganizationId: Organisation.OrganisationId.make("org_123"),
	},
	organizations: [
		{
			id: Organisation.OrganisationId.make("org_123"),
			name: "Cap",
			iconUrl: "https://cap.so/icon.png",
			role: "owner",
		},
		{
			id: Organisation.OrganisationId.make("org_456"),
			name: "Design",
			iconUrl: null,
			role: "member",
		},
	],
	activeOrganizationId: Organisation.OrganisationId.make("org_123"),
	rootFolders: [],
};

describe("OrgSwitcher", () => {
	it("uses the organization icon when the active org has one", async () => {
		const tree = await renderTree(
			<OrgSwitcher bootstrap={bootstrap} onChange={vi.fn()} />,
		);

		expect(hasImageSourceUri(tree, "https://cap.so/icon.png")).toBe(true);
	});

	it("uses a native organization action sheet with roles and disabled active org", async () => {
		const onChange = vi.fn(() => Promise.resolve());
		const renderer = await renderComponent(
			<OrgSwitcher bootstrap={bootstrap} onChange={onChange} />,
		);
		const [trigger] = renderer.root.findAllByProps({
			accessibilityLabel: "Switch organization",
		});
		if (!trigger) throw new Error("Organization switcher was not rendered");

		expect(resolveStyle(trigger.props.style, true)).toMatchObject({
			backgroundColor: "#f0f0f0",
			borderColor: "#d9d9d9",
		});

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			trigger.props.onPress();
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 2,
				disabledButtonIndices: [0],
				disabledButtonTintColor: "#8d8d8d",
				options: ["Cap (Owner)", "Design (Member)", "Cancel"],
				title: "Organization",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);

		const [, callback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!callback) throw new Error("Organization action sheet did not open");

		await act(async () => {
			callback(1);
		});

		expect(onChange).toHaveBeenCalledWith("org_456");
	});
});
