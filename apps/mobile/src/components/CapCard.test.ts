import { Video } from "@cap/web-domain";
import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { MobileCapSummary } from "@/api/mobile";
import { CapCard } from "./CapCard";
import { getCapCardViewModel } from "./capCardViewModel";

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

const getTextNodes = (node: JsonNode): string[] => {
	if (!node) return [];
	if (typeof node === "string") return [node];
	if (Array.isArray(node)) return node.flatMap(getTextNodes);
	return node.children?.flatMap(getTextNodes) ?? [];
};

const hasProp = (node: JsonNode, prop: string, value: unknown): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node))
		return node.some((item) => hasProp(item, prop, value));
	if (node.props[prop] === value) return true;
	return node.children?.some((child) => hasProp(child, prop, value)) ?? false;
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
		ActivityIndicator: createHost("ActivityIndicator"),
		Pressable: createHost("Pressable"),
		StyleSheet: {
			absoluteFillObject: {
				bottom: 0,
				left: 0,
				position: "absolute",
				right: 0,
				top: 0,
			},
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

vi.mock("react-native-svg", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		default: createHost("Svg"),
		Circle: createHost("Circle"),
	};
});

const cap: MobileCapSummary = {
	id: Video.VideoId.make("video_123"),
	shareUrl: "https://cap.so/s/video_123",
	title: "Launch review",
	createdAt: "2026-05-18T10:00:00.000Z",
	updatedAt: "2026-05-18T10:30:00.000Z",
	ownerName: "Richie",
	durationSeconds: 125,
	thumbnailUrl: null,
	folderId: null,
	public: true,
	protected: false,
	viewCount: 7,
	commentCount: 2,
	reactionCount: 3,
	upload: null,
};

describe("getCapCardViewModel", () => {
	it("formats card rendering state", () => {
		expect(
			getCapCardViewModel(cap, new Date("2026-05-18T11:00:00.000Z")),
		).toMatchObject({
			date: "an hour ago",
			duration: "2 mins",
			visibility: "Shared",
			accessibilityLabel: "Launch review, an hour ago, Shared",
		});
	});

	it("formats active upload state for the thumbnail overlay", () => {
		expect(
			getCapCardViewModel(
				{
					...cap,
					upload: {
						uploaded: 25,
						total: 100,
						phase: "uploading",
						processingProgress: 0,
						processingMessage: null,
						processingError: null,
					},
				},
				new Date("2026-05-18T11:00:00.000Z"),
			),
		).toMatchObject({
			uploadStatusText: "25% uploaded",
			uploadProgress: 25,
			uploadFailed: false,
			accessibilityLabel: "Launch review, an hour ago, Shared, 25% uploaded",
		});
	});

	it("keeps password protection separate from sharing state", () => {
		expect(
			getCapCardViewModel(
				{
					...cap,
					public: false,
					protected: true,
				},
				new Date("2026-05-18T11:00:00.000Z"),
			),
		).toMatchObject({
			date: "an hour ago",
			visibility: "Not shared",
			accessibilityLabel: "Launch review, an hour ago, Not shared",
		});
	});

	it("uses processing progress as a percent value", () => {
		expect(
			getCapCardViewModel({
				...cap,
				upload: {
					uploaded: 100,
					total: 100,
					phase: "processing",
					processingProgress: 42,
					processingMessage: "Processing",
					processingError: null,
				},
			}).uploadProgress,
		).toBe(42);
	});

	it("keeps non-finite upload progress display-safe", () => {
		const uploading = getCapCardViewModel(
			{
				...cap,
				upload: {
					uploaded: Number.NaN,
					total: Number.NaN,
					phase: "uploading",
					processingProgress: 0,
					processingMessage: null,
					processingError: null,
				},
			},
			new Date("2026-05-18T11:00:00.000Z"),
		);
		const processing = getCapCardViewModel({
			...cap,
			upload: {
				uploaded: 100,
				total: 100,
				phase: "processing",
				processingProgress: Number.POSITIVE_INFINITY,
				processingMessage: "Processing",
				processingError: null,
			},
		});

		expect(uploading).toMatchObject({
			uploadStatusText: "0% uploaded",
			uploadProgress: 0,
			accessibilityLabel: "Launch review, an hour ago, Shared, 0% uploaded",
		});
		expect(processing.uploadProgress).toBe(0);
	});

	it("matches the web finishing state for completed processing records", () => {
		expect(
			getCapCardViewModel({
				...cap,
				upload: {
					uploaded: 100,
					total: 100,
					phase: "complete",
					processingProgress: 100,
					processingMessage: null,
					processingError: null,
				},
			}).uploadStatusText,
		).toBe("Finishing up");
	});
});

describe("CapCard", () => {
	it("uses a branded thumbnail placeholder when a Cap has no thumbnail", async () => {
		const tree = await renderTree(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);

		expect(hasProp(tree, "fill", "#cecece")).toBe(true);
		expect(hasProp(tree, "name", "play.fill")).toBe(false);
	});

	it("exposes active upload progress as a native progressbar", async () => {
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap: {
					...cap,
					upload: {
						uploaded: 25,
						total: 100,
						phase: "uploading",
						processingProgress: 0,
						processingMessage: null,
						processingError: null,
					},
				},
				onPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [progress] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload progress",
		});
		if (!progress) throw new Error("Upload progress was not rendered");

		expect(progress.props.accessibilityRole).toBe("progressbar");
		expect(progress.props.accessibilityValue).toEqual({
			max: 100,
			min: 0,
			now: 25,
			text: "25%",
		});
	});

	it("exposes processing upload state as an indeterminate progressbar", async () => {
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap: {
					...cap,
					upload: {
						uploaded: 100,
						total: 100,
						phase: "processing",
						processingProgress: 0,
						processingMessage: "Processing",
						processingError: null,
					},
				},
				onPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [progress] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload progress",
		});
		if (!progress) throw new Error("Upload progress was not rendered");

		expect(progress.props.accessibilityRole).toBe("progressbar");
		expect(progress.props.accessibilityValue).toEqual({
			text: "Processing",
		});
	});

	it("shows copy, share, and more actions together", async () => {
		const tree = await renderTree(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				onCopyPress: vi.fn(),
				onSharePress: vi.fn(),
				onMenuPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);

		expect(
			hasProp(tree, "accessibilityLabel", "Copy link for Launch review"),
		).toBe(true);
		expect(hasProp(tree, "accessibilityHint", "Copies this Cap link")).toBe(
			true,
		);
		expect(hasProp(tree, "accessibilityLabel", "Share Launch review")).toBe(
			true,
		);
		expect(
			hasProp(tree, "accessibilityHint", "Opens the native share sheet"),
		).toBe(true);
		expect(
			hasProp(tree, "accessibilityLabel", "More actions for Launch review"),
		).toBe(true);
		expect(hasProp(tree, "accessibilityHint", "Opens Cap actions")).toBe(true);
	});

	it("uses the Cap web neutral button surface for card actions", async () => {
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				onCopyPress: vi.fn(),
				onSharePress: vi.fn(),
				onMenuPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [copyButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Copy link for Launch review",
		});
		if (!copyButton) throw new Error("Copy action was not rendered");

		expect(resolveStyle(copyButton.props.style)).toMatchObject({
			width: 32,
			height: 32,
			backgroundColor: "#f0f0f0",
			borderColor: "#e0e0e0",
		});
		expect(resolveStyle(copyButton.props.style, true)).toMatchObject({
			backgroundColor: "#e0e0e0",
			borderColor: "#cecece",
		});
		expect(copyButton.props.hitSlop).toEqual({
			bottom: 6,
			left: 6,
			right: 6,
			top: 6,
		});
	});

	it("opens visibility controls from the shared status row like the web card", async () => {
		const onVisibilityPress = vi.fn();
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				onVisibilityPress,
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [shareState] = renderer.root.findAllByProps({
			accessibilityLabel: "Change sharing for Launch review",
		});
		if (!shareState) throw new Error("Shared status action was not rendered");
		const stopPropagation = vi.fn();

		expect(shareState.props.accessibilityHint).toBe("Opens sharing settings");
		expect(shareState.props.accessibilityState).toEqual({
			busy: false,
			disabled: false,
		});
		expect(shareState.props.hitSlop).toEqual({
			bottom: 6,
			left: 6,
			right: 6,
			top: 6,
		});

		await act(async () => {
			shareState.props.onPress({ stopPropagation });
		});

		expect(stopPropagation).toHaveBeenCalled();
		expect(onVisibilityPress).toHaveBeenCalledTimes(1);
	});

	it("shows a disabled sharing state while the card visibility is updating", async () => {
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				onVisibilityPress: vi.fn(),
				visibilityBusy: true,
				visibilityDisabled: true,
				visibilityDisabledHint: "Sharing update is in progress",
				visibilityAccessibilityValue: "Updating sharing for Launch review",
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [shareState] = renderer.root.findAllByProps({
			accessibilityLabel: "Change sharing for Launch review",
		});
		if (!shareState) throw new Error("Shared status action was not rendered");

		expect(getTextNodes(renderer.toJSON())).toContain("Shared");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Updating...");
		expect(shareState.props.disabled).toBe(true);
		expect(shareState.props.accessibilityHint).toBe(
			"Sharing update is in progress",
		);
		expect(shareState.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(shareState.props.accessibilityValue).toEqual({
			text: "Updating sharing for Launch review",
		});
		expect(resolveStyle(shareState.props.style, true)).toMatchObject({
			backgroundColor: "#f9f9f9",
		});
	});

	it("opens analytics from the metrics row like the web card", async () => {
		const onAnalyticsPress = vi.fn();
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap,
				onAnalyticsPress,
				onPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [metricsRow] = renderer.root.findAllByProps({
			accessibilityLabel: "View analytics for Launch review",
		});
		if (!metricsRow) throw new Error("Analytics action was not rendered");
		const stopPropagation = vi.fn();

		expect(metricsRow.props.accessibilityHint).toBe(
			"Opens analytics in a browser sheet",
		);
		expect(metricsRow.props.accessibilityState).toEqual({
			disabled: false,
		});

		await act(async () => {
			metricsRow.props.onPress({ stopPropagation });
		});

		expect(stopPropagation).toHaveBeenCalled();
		expect(onAnalyticsPress).toHaveBeenCalledTimes(1);
	});

	it("marks metrics as disabled when analytics are informational only", async () => {
		const renderer = await renderComponent(
			React.createElement(CapCard, {
				cap,
				onPress: vi.fn(),
				now: new Date("2026-05-18T11:00:00.000Z"),
			}),
		);
		const [metricsRow] = renderer.root.findAllByProps({
			accessibilityLabel: "View analytics for Launch review",
		});
		if (!metricsRow) throw new Error("Metrics row was not rendered");

		expect(metricsRow.props.disabled).toBe(true);
		expect(metricsRow.props.accessibilityHint).toBeUndefined();
		expect(metricsRow.props.accessibilityState).toEqual({
			disabled: true,
		});
	});
});
