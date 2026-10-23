import { Video } from "@cap/web-domain";
import type { ReactElement, ReactNode } from "react";
import { Switch } from "react-native";
import TestRenderer, {
	act,
	type ReactTestInstance,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { MobileCapSummary } from "@/api/mobile";
import { CapSettingsSheet } from "./CapSettingsSheet";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

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

const getInstanceText = (node: ReactTestInstance): string[] =>
	node.children.flatMap((child) =>
		typeof child === "string" ? [child] : getInstanceText(child),
	);

const getNodeType = (node: ReactTestInstance) => String(node.type);
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
		Modal: createHost("Modal"),
		Pressable: createHost("Pressable"),
		ScrollView: createHost("ScrollView"),
		StyleSheet: {
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Switch: createHost("Switch"),
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

vi.mock("@/components/GlassSurface", async () => {
	const React = await import("react");
	return {
		GlassSurface: ({ children, ...props }: HostProps) =>
			React.createElement("GlassSurface", props, children),
	};
});

const cap: MobileCapSummary = {
	id: Video.VideoId.make("video_123"),
	shareUrl: "https://cap.so/s/video_123",
	title: "Launch review",
	createdAt: "2026-05-18T10:00:00.000Z",
	updatedAt: "2026-05-18T10:30:00.000Z",
	ownerName: "Richie",
	durationSeconds: null,
	thumbnailUrl: null,
	folderId: null,
	public: true,
	protected: true,
	viewCount: 0,
	commentCount: 0,
	reactionCount: 0,
	upload: null,
};

describe("CapSettingsSheet", () => {
	it("renders native settings rows for Cap actions", async () => {
		const renderer = await renderComponent(
			<CapSettingsSheet
				cap={cap}
				visible
				onClose={vi.fn()}
				onCopyLink={vi.fn()}
				onDelete={vi.fn()}
				onPassword={vi.fn()}
				onRename={vi.fn()}
				onSaveVideo={vi.fn()}
				onShareLink={vi.fn()}
				onViewAnalytics={vi.fn()}
				onVisibilityChange={vi.fn()}
			/>,
		);

		expect(getTextNodes(renderer.toJSON())).toEqual(
			expect.arrayContaining([
				"Settings",
				"Launch review",
				"Title",
				"View analytics",
				"Public link",
				"Password",
				"Protected",
				"Copy link",
				"Share",
				"Save video",
				"Delete Cap",
			]),
		);
		expect(
			renderer.root.findAll((node) => getNodeType(node) === "GlassSurface"),
		).toHaveLength(4);
		expect(
			renderer.root.find((node) => getNodeType(node) === "Modal").props
				.allowSwipeDismissal,
		).toBe(true);
		const closeButton = renderer.root.findByProps({
			accessibilityLabel: "Close Cap settings",
		});
		expect(closeButton.props.accessibilityHint).toBe("Dismisses Cap settings");
		expect(closeButton.props.hitSlop).toBe(8);
		expect(
			renderer.root.findByProps({ accessibilityHint: "Renames this Cap" }),
		).toBeTruthy();
		expect(
			renderer.root.findByProps({
				accessibilityHint: "Copies this Cap link",
			}),
		).toBeTruthy();
		expect(
			renderer.root.findByProps({
				accessibilityHint: "Opens the native share sheet",
			}),
		).toBeTruthy();
		expect(
			renderer.root.findByProps({ accessibilityHint: "Deletes this Cap" }),
		).toBeTruthy();
	});

	it("updates public link with the native switch", async () => {
		const onVisibilityChange = vi.fn();
		const renderer = await renderComponent(
			<CapSettingsSheet
				cap={cap}
				visible
				onClose={vi.fn()}
				onCopyLink={vi.fn()}
				onDelete={vi.fn()}
				onPassword={vi.fn()}
				onRename={vi.fn()}
				onSaveVideo={vi.fn()}
				onShareLink={vi.fn()}
				onVisibilityChange={onVisibilityChange}
			/>,
		);

		const switchNode = renderer.root.findByType(Switch);
		expect(switchNode.props).toMatchObject({
			accessibilityLabel: "Public link",
			accessibilityHint: "Toggles public link sharing",
			accessibilityRole: "switch",
			accessibilityState: {
				checked: true,
				disabled: false,
			},
			ios_backgroundColor: "#e0e0e0",
			trackColor: {
				false: "#e0e0e0",
				true: "#8ec8f6",
			},
		});

		switchNode.props.onValueChange(false);

		expect(onVisibilityChange).toHaveBeenCalledWith(cap, false);
	});

	it("marks disabled save actions as unavailable in the native settings sheet", async () => {
		const onSaveVideo = vi.fn();
		const renderer = await renderComponent(
			<CapSettingsSheet
				cap={cap}
				visible
				onClose={vi.fn()}
				onCopyLink={vi.fn()}
				onDelete={vi.fn()}
				onPassword={vi.fn()}
				onRename={vi.fn()}
				onSaveVideo={onSaveVideo}
				onShareLink={vi.fn()}
				onVisibilityChange={vi.fn()}
				saveDisabled
				saveDisabledAccessibilityValue="Saving video for Launch review"
			/>,
		);

		const saveRow = renderer.root
			.findAllByProps({ accessibilityRole: "button" })
			.find((node) => getInstanceText(node).includes("Save video"));
		if (!saveRow) throw new Error("Save video row was not rendered");

		expect(saveRow.props.accessibilityState).toEqual({ disabled: true });
		expect(saveRow.props.disabled).toBe(true);
		expect(saveRow.props.accessibilityHint).toBe("Save is in progress");
		expect(saveRow.props.accessibilityValue).toEqual({
			text: "Saving video for Launch review",
		});
		expect(getInstanceText(saveRow)).not.toContain("Saving...");
		expect(resolveStyle(saveRow.props.style)).toMatchObject({
			backgroundColor: "#f9f9f9",
		});
	});

	it("marks disabled sharing updates as in progress", async () => {
		const onVisibilityChange = vi.fn();
		const renderer = await renderComponent(
			<CapSettingsSheet
				cap={cap}
				visible
				onClose={vi.fn()}
				onCopyLink={vi.fn()}
				onDelete={vi.fn()}
				onPassword={vi.fn()}
				onRename={vi.fn()}
				onSaveVideo={vi.fn()}
				onShareLink={vi.fn()}
				onVisibilityChange={onVisibilityChange}
				visibilityDisabled
				visibilityDisabledAccessibilityValue="Updating sharing for Launch review"
			/>,
		);

		const publicLinkRow = renderer.root
			.findAllByProps({ accessibilityLabel: "Public link" })
			.find((node) => getInstanceText(node).includes("Public link"));
		if (!publicLinkRow) throw new Error("Public link row was not rendered");
		const switchNode = renderer.root.findByType(Switch);
		expect(publicLinkRow.props.accessibilityValue).toEqual({
			text: "Updating sharing for Launch review",
		});
		expect(getInstanceText(publicLinkRow)).not.toContain("Updating...");
		expect(switchNode.props.accessibilityState).toEqual({
			checked: true,
			disabled: true,
		});
		expect(switchNode.props.accessibilityHint).toBe(
			"Sharing update is in progress",
		);
		expect(switchNode.props.disabled).toBe(true);
	});

	it("opens analytics from the native settings sheet", async () => {
		const onViewAnalytics = vi.fn();
		const renderer = await renderComponent(
			<CapSettingsSheet
				cap={cap}
				visible
				onClose={vi.fn()}
				onCopyLink={vi.fn()}
				onDelete={vi.fn()}
				onPassword={vi.fn()}
				onRename={vi.fn()}
				onSaveVideo={vi.fn()}
				onShareLink={vi.fn()}
				onViewAnalytics={onViewAnalytics}
				onVisibilityChange={vi.fn()}
			/>,
		);

		const analyticsRow = renderer.root
			.findAllByProps({ accessibilityRole: "button" })
			.find((node) => getInstanceText(node).includes("View analytics"));
		if (!analyticsRow) throw new Error("Analytics row was not rendered");
		expect(analyticsRow.props.accessibilityHint).toBe("Opens native analytics");

		await act(async () => {
			analyticsRow.props.onPress();
		});

		expect(onViewAnalytics).toHaveBeenCalledWith(cap);
	});
});
