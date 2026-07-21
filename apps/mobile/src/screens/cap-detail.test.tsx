import { Comment, User, Video } from "@cap/web-domain";
import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	MobileCapDetail,
	MobileComment,
	MobilePlaybackResponse,
} from "@/api/mobile";
import CapDetailScreen from "../../app/caps/[id]";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

type AuthStub = {
	status: "signedIn";
	client: {
		createComment: ReturnType<typeof vi.fn>;
		createReaction: ReturnType<typeof vi.fn>;
		deleteCap: ReturnType<typeof vi.fn>;
		getCap: ReturnType<typeof vi.fn>;
		getPlayback: ReturnType<typeof vi.fn>;
		updateCapSharing: ReturnType<typeof vi.fn>;
	};
	refresh: ReturnType<typeof vi.fn>;
};

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const detail: MobileCapDetail = {
	cap: {
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
		protected: true,
		viewCount: 17,
		commentCount: 2,
		reactionCount: 3,
		upload: null,
	},
	summary: "A short launch walkthrough.",
	chapters: [],
	transcriptionStatus: "COMPLETE",
	comments: [],
	shareUrl: "https://cap.so/s/video_123",
};

const playback: MobilePlaybackResponse = {
	kind: "mp4",
	transcriptUrl: null,
	url: "https://cap.so/video.mp4",
};

const createdComment = (content: string): MobileComment => ({
	id: Comment.CommentId.make("comment_123"),
	videoId: Video.VideoId.make("video_123"),
	type: "text",
	content,
	timestamp: null,
	parentCommentId: null,
	createdAt: "2026-05-18T10:31:00.000Z",
	updatedAt: "2026-05-18T10:31:00.000Z",
	author: {
		id: User.UserId.make("user_123"),
		name: "Richie",
		imageUrl: null,
	},
});

const createDeferred = <T,>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
};

const authState = vi.hoisted((): { value: AuthStub | null } => ({
	value: null,
}));

const videoPlayerState = vi.hoisted(() => ({
	replaceAsync: vi.fn(() => Promise.resolve()),
}));

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
	const resolved =
		typeof style === "function"
			? (style as (state: { pressed: boolean }) => unknown)({ pressed })
			: style;
	const styles = Array.isArray(resolved) ? resolved : [resolved];
	return Object.assign({}, ...styles.filter(Boolean));
};

const createAuth = (): AuthStub => ({
	status: "signedIn",
	client: {
		createComment: vi.fn(),
		createReaction: vi.fn(),
		deleteCap: vi.fn(),
		getCap: vi.fn(() => Promise.resolve(detail)),
		getPlayback: vi.fn(() => Promise.resolve(playback)),
		updateCapSharing: vi.fn(),
	},
	refresh: vi.fn(() => Promise.resolve()),
});

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
		Alert: {
			alert: vi.fn(),
		},
		ActivityIndicator: createHost("ActivityIndicator"),
		Linking: {
			openSettings: vi.fn(),
		},
		Platform: {
			OS: "ios",
		},
		Pressable: createHost("Pressable"),
		Share: {
			share: vi.fn(),
		},
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
		TextInput: createHost("TextInput"),
		View: createHost("View"),
	};
});

vi.mock("expo-clipboard", () => ({
	setStringAsync: vi.fn(),
}));

vi.mock("expo-image", async () => {
	const React = await import("react");
	return {
		Image: (props: Record<string, unknown>) =>
			React.createElement("Image", props),
	};
});

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		router: {
			back: vi.fn(),
		},
		Stack: {
			Screen: (props: HostProps) =>
				React.createElement("StackScreen", {
					...props,
					testID: "stack-screen",
				}),
		},
		useLocalSearchParams: () => ({ id: "video_123" }),
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: Record<string, unknown>) =>
			React.createElement("SymbolView", props),
	};
});

vi.mock("expo-video", async () => {
	const React = await import("react");
	return {
		VideoView: (props: Record<string, unknown>) =>
			React.createElement("VideoView", props),
		useVideoPlayer: () => videoPlayerState,
	};
});

vi.mock("expo-web-browser", () => ({
	openBrowserAsync: vi.fn(),
}));

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
	useAuth: () => authState.value,
}));

vi.mock("@/auth/SignInPanel", async () => {
	const React = await import("react");
	return {
		SignInPanel: () => React.createElement("SignInPanel"),
	};
});

vi.mock("@/caps/CapSettingsSheet", async () => {
	const React = await import("react");
	return {
		CapSettingsSheet: (props: Record<string, unknown>) =>
			React.createElement("CapSettingsSheet", {
				...props,
				testID: "cap-settings-sheet",
			}),
	};
});

vi.mock("@/caps/passwordActions", () => ({
	showCapPasswordActions: vi.fn(),
}));

vi.mock("@/caps/saveCapVideo", () => ({
	PhotosPermissionDeniedError: class PhotosPermissionDeniedError extends Error {},
	saveCapVideoToPhotos: vi.fn(),
}));

vi.mock("@/caps/titleActions", () => ({
	showCapTitleActions: vi.fn(),
}));

vi.mock("@/components/ActionButton", async () => {
	const React = await import("react");
	return {
		ActionButton: ({
			children,
			label,
			onPress,
			...props
		}: {
			children?: ReactNode;
			label: string;
			onPress?: () => void;
			[key: string]: unknown;
		}) =>
			React.createElement(
				"ActionButton",
				{
					...props,
					accessibilityLabel: props.accessibilityLabel ?? label,
					onPress,
				},
				children ?? label,
			),
	};
});

vi.mock("@/components/GlassSurface", async () => {
	const React = await import("react");
	return {
		GlassSurface: ({ children }: { children?: ReactNode }) =>
			React.createElement("GlassSurface", null, children),
	};
});

vi.mock("@/components/Screen", async () => {
	const React = await import("react");
	return {
		Screen: ({
			automaticallyAdjustKeyboardInsets,
			children,
			loading,
		}: {
			automaticallyAdjustKeyboardInsets?: boolean;
			children?: ReactNode;
			loading?: boolean;
		}) =>
			React.createElement(
				"Screen",
				{ automaticallyAdjustKeyboardInsets },
				loading ? React.createElement("Text", null, "Loading") : children,
			),
	};
});

describe("Cap detail screen", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		videoPlayerState.replaceAsync.mockResolvedValue(undefined);
		authState.value = createAuth();
	});

	it("announces Cap detail load errors with a retry action", async () => {
		const auth = createAuth();
		auth.client.getCap = vi.fn(() =>
			Promise.reject(new Error("Network unavailable")),
		);
		authState.value = auth;

		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(text).toContain("Unable to load Cap");
		expect(text).toContain("Network unavailable");
		expect(hasProp(tree, "accessibilityRole", "alert")).toBe(true);
		expect(hasProp(tree, "accessibilityLiveRegion", "polite")).toBe(true);
		expect(
			hasProp(
				tree,
				"accessibilityLabel",
				"Cap detail error: Network unavailable",
			),
		).toBe(true);

		const [retryButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Try again",
		});
		if (!retryButton)
			throw new Error("Cap detail retry action was not rendered");
		expect(retryButton.props.accessibilityHint).toBe("Reloads this Cap");

		await act(async () => {
			retryButton.props.onPress();
			await Promise.resolve();
		});

		expect(auth.client.getCap).toHaveBeenCalledTimes(2);
	});

	it("shows web-matching sharing, analytics, and action labels", async () => {
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(text).toContain("Launch review");
		expect(text).toContain("Shared");
		expect(text).toContain("Password protected");
		expect(text).toContain("17");
		expect(text).toContain("2");
		expect(text).toContain("3");
		expect(text).toContain("Copy link");
		expect(text).toContain("Save video");
		expect(text).toContain("View analytics");
		expect(hasProp(tree, "accessibilityHint", "Copies this Cap link")).toBe(
			true,
		);
		expect(
			hasProp(tree, "accessibilityHint", "Opens the native share sheet"),
		).toBe(true);
		expect(
			hasProp(tree, "accessibilityHint", "Saves this video to Photos"),
		).toBe(true);
		expect(
			hasProp(tree, "accessibilityLabel", "Change sharing for Launch review"),
		).toBe(true);
		expect(hasProp(tree, "accessibilityHint", "Opens sharing settings")).toBe(
			true,
		);
		expect(
			hasProp(tree, "accessibilityLabel", "View analytics for Launch review"),
		).toBe(true);
		expect(
			hasProp(tree, "accessibilityHint", "Opens analytics in a browser sheet"),
		).toBe(true);
	});

	it("loads segmented playback explicitly as HLS with native controls", async () => {
		const auth = createAuth();
		auth.client.getPlayback = vi.fn(() =>
			Promise.resolve({
				kind: "hls" as const,
				transcriptUrl: null,
				url: "https://cap.so/api/playlist?videoId=video_123",
			}),
		);
		authState.value = auth;

		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);

		expect(videoPlayerState.replaceAsync).toHaveBeenCalledWith({
			contentType: "hls",
			uri: "https://cap.so/api/playlist?videoId=video_123",
		});
		const video = renderer.root.find(
			(node) => String(node.type) === "VideoView",
		);
		expect(video.props).toMatchObject({
			allowsPictureInPicture: true,
			contentFit: "contain",
			nativeControls: true,
		});
		const screen = renderer.root.find((node) => String(node.type) === "Screen");
		expect(screen.props.automaticallyAdjustKeyboardInsets).toBe(true);
	});

	it("offers a full reaction set without clipping it to one row", async () => {
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);

		for (const emoji of ["😂", "😍", "😮", "🙌", "👍", "👎", "👏", "🔥"]) {
			expect(
				renderer.root.findAll(
					(node) =>
						String(node.type) === "ActionButton" &&
						node.props.accessibilityLabel === `React with ${emoji}`,
				),
			).toHaveLength(1);
		}
	});

	it("uses native affordances for the header menu and comment composer", async () => {
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const stackScreen = renderer.root.findByProps({
			testID: "stack-screen",
		});
		const headerRight = stackScreen.props.options
			.headerRight as () => ReactNode;
		let headerRenderer: ReactTestRenderer | null = null;

		await act(async () => {
			headerRenderer = TestRenderer.create(headerRight() as ReactElement);
		});

		const headerAction = (
			headerRenderer as unknown as ReactTestRenderer
		).root.findByProps({
			accessibilityLabel: "More actions",
		});
		expect(headerAction.props.accessibilityState).toEqual({
			disabled: false,
		});
		expect(headerAction.props.accessibilityHint).toBe("Opens Cap settings");
		expect(headerAction.props.hitSlop).toBe(10);
		expect(resolveStyle(headerAction.props.style, true)).toMatchObject({
			backgroundColor: "#f0f0f0",
		});

		const [commentInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Comment",
		});
		if (!commentInput) throw new Error("Comment input was not rendered");

		expect(commentInput.props.accessibilityState).toEqual({
			disabled: false,
		});
		expect(commentInput.props.enablesReturnKeyAutomatically).toBe(true);
		expect(commentInput.props.keyboardAppearance).toBe("light");
		expect(commentInput.props.returnKeyType).toBe("send");
		expect(commentInput.props.selectionColor).toBe("#0d74ce");
		expect(commentInput.props.submitBehavior).toBe("blurAndSubmit");

		const [disabledSend] = renderer.root.findAllByProps({
			accessibilityLabel: "Send comment",
		});
		expect(disabledSend?.props.disabled).toBe(true);

		await act(async () => {
			commentInput.props.onChangeText("Ship it");
		});

		const [enabledSend] = renderer.root.findAllByProps({
			accessibilityLabel: "Send comment",
		});
		expect(enabledSend?.props.disabled).toBe(false);
	});

	it("opens native settings from the sharing status", async () => {
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const [shareStatus] = renderer.root.findAllByProps({
			accessibilityLabel: "Change sharing for Launch review",
		});
		if (!shareStatus) throw new Error("Sharing status row was not rendered");

		await act(async () => {
			shareStatus.props.onPress();
		});

		const [sheet] = renderer.root.findAllByProps({
			testID: "cap-settings-sheet",
		});
		expect(sheet?.props.visible).toBe(true);
	});

	it("opens analytics in the native browser sheet", async () => {
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const [analytics] = renderer.root.findAllByProps({
			accessibilityLabel: "View analytics for Launch review",
		});
		if (!analytics) throw new Error("Analytics row was not rendered");

		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		openBrowserAsync.mockClear();

		await act(async () => {
			analytics.props.onPress();
		});

		expect(openBrowserAsync).toHaveBeenCalledWith(
			"https://cap.so/dashboard/analytics?capId=video_123",
		);
	});

	it("shows a save-specific busy state without blocking sharing as saving", async () => {
		const saveDeferred = createDeferred<string>();
		const { saveCapVideoToPhotos } = await import("@/caps/saveCapVideo");
		vi.mocked(saveCapVideoToPhotos).mockReturnValueOnce(saveDeferred.promise);
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const [saveButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Save video",
		});
		if (!saveButton) throw new Error("Save video button was not rendered");

		await act(async () => {
			saveButton.props.onPress();
			await Promise.resolve();
		});

		const [savingButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Save video",
		});
		if (!savingButton) throw new Error("Saving button was not rendered");
		expect(savingButton.props.loading).toBe(true);
		expect(savingButton.props.accessibilityHint).toBe("Save is in progress");
		expect(savingButton.props.accessibilityValue).toEqual({
			text: "Saving video for Launch review",
		});

		const [sheet] = renderer.root.findAllByProps({
			testID: "cap-settings-sheet",
		});
		expect(sheet?.props.saveDisabled).toBe(true);
		expect(sheet?.props.saveDisabledHint).toBe("Save is in progress");
		expect(sheet?.props.saveDisabledValue).toBeUndefined();
		expect(sheet?.props.saveDisabledAccessibilityValue).toBe(
			"Saving video for Launch review",
		);
		expect(sheet?.props.visibilityDisabled).toBe(true);
		expect(sheet?.props.visibilityDisabledHint).toBe(
			"Current Cap action is in progress",
		);
		expect(sheet?.props.visibilityDisabledValue).toBeUndefined();

		await act(async () => {
			saveDeferred.resolve("Launch review.mp4");
			await saveDeferred.promise;
		});

		expect(getTextNodes(renderer.toJSON())).toContain("Saved");
	});

	it("keeps save idle while a comment is sending", async () => {
		const commentDeferred = createDeferred<MobileComment>();
		const auth = createAuth();
		auth.client.createComment.mockReturnValueOnce(commentDeferred.promise);
		authState.value = auth;
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const [commentInput] = renderer.root.findAllByProps({
			accessibilityLabel: "Comment",
		});
		if (!commentInput) throw new Error("Comment input was not rendered");

		await act(async () => {
			commentInput.props.onChangeText("Ship it");
		});

		const [sendButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Send comment",
		});
		if (!sendButton) throw new Error("Send button was not rendered");

		await act(async () => {
			sendButton.props.onPress();
			await Promise.resolve();
		});

		const [sendingButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Sending comment on Launch review",
		});
		const [saveButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Save video",
		});
		if (!sendingButton) throw new Error("Sending button was not rendered");
		if (!saveButton) throw new Error("Save video button was not rendered");

		expect(sendingButton.props.loading).toBe(true);
		expect(sendingButton.props.accessibilityHint).toBe("Comment is being sent");
		expect(saveButton.props.loading).toBe(false);
		expect(saveButton.props.disabled).toBe(true);
		expect(saveButton.props.accessibilityHint).toBe(
			"Current Cap action is in progress",
		);
		expect(getTextNodes(renderer.toJSON())).not.toContain("Saving...");

		const [sheet] = renderer.root.findAllByProps({
			testID: "cap-settings-sheet",
		});
		expect(sheet?.props.saveDisabledValue).toBe("Unavailable");
		expect(sheet?.props.visibilityDisabledValue).toBeUndefined();

		await act(async () => {
			commentDeferred.resolve(createdComment("Ship it"));
			await commentDeferred.promise;
		});

		expect(getTextNodes(renderer.toJSON())).toContain("Ship it");
	});

	it("marks the settings sheet sharing row as updating during visibility changes", async () => {
		const sharingDeferred = createDeferred<MobileCapDetail["cap"]>();
		const auth = createAuth();
		auth.client.updateCapSharing.mockReturnValueOnce(sharingDeferred.promise);
		authState.value = auth;
		const renderer = await renderComponent(
			React.createElement(CapDetailScreen),
		);
		const [sheet] = renderer.root.findAllByProps({
			testID: "cap-settings-sheet",
		});
		if (!sheet) throw new Error("Cap settings sheet was not rendered");

		await act(async () => {
			sheet.props.onVisibilityChange(detail.cap, false);
			await Promise.resolve();
		});

		const [busySheet] = renderer.root.findAllByProps({
			testID: "cap-settings-sheet",
		});
		const [sharingStatus] = renderer.root.findAllByProps({
			accessibilityLabel: "Change sharing for Launch review",
		});
		expect(auth.client.updateCapSharing).toHaveBeenCalledWith("video_123", {
			public: false,
		});
		expect(sharingStatus?.props.accessibilityHint).toBe(
			"Sharing update is in progress",
		);
		expect(sharingStatus?.props.accessibilityState).toEqual({
			disabled: true,
		});
		expect(sharingStatus?.props.accessibilityValue).toEqual({
			text: "Updating sharing for Launch review",
		});
		expect(getTextNodes(renderer.toJSON())).toContain("Shared");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Updating...");
		expect(busySheet?.props.visibilityDisabled).toBe(true);
		expect(busySheet?.props.visibilityDisabledHint).toBe(
			"Sharing update is in progress",
		);
		expect(busySheet?.props.visibilityDisabledValue).toBeUndefined();
		expect(busySheet?.props.visibilityDisabledAccessibilityValue).toBe(
			"Updating sharing for Launch review",
		);
		expect(busySheet?.props.saveDisabledValue).toBe("Unavailable");

		await act(async () => {
			sharingDeferred.resolve({ ...detail.cap, public: false });
			await sharingDeferred.promise;
		});
	});
});
