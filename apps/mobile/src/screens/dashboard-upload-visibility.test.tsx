import React, { type ReactElement, type ReactNode } from "react";
import TestRenderer, {
	act,
	type ReactTestRenderer,
	type ReactTestRendererJSON,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CapsScreen from "../../app/(tabs)";
import UploadScreen from "../../app/(tabs)/upload";

type AuthStub = {
	status: "signedIn";
	apiKey: string;
	bootstrap: {
		activeOrganizationId: string;
		spaces?: Array<{
			id: string;
			name: string;
			iconUrl: null;
			kind: "organization" | "space";
			privacy: "Public" | "Private";
			role: "owner" | "admin" | "member" | null;
			canManage: boolean;
			hasPassword: boolean;
		}>;
		user: {
			email: string;
			name: string | null;
		};
	};
	client: {
		createFolder: (input: {
			color?: string;
			name: string;
			spaceId?: string;
		}) => Promise<{
			color: string;
			id: string;
			name: string;
			parentId: null;
			videoCount: number;
		}>;
		getCap: (id: string) => Promise<{
			cap: {
				upload: null;
			};
		}>;
		getCapStatuses: (ids: readonly string[]) => Promise<{
			caps: Array<{
				id: string;
				upload: Record<string, unknown> | null;
			}>;
		}>;
		listCaps: (input?: {
			limit?: number;
			page?: number;
			spaceId?: string | null;
		}) => Promise<{
			caps: unknown[];
			collectionTotal?: number;
			folders: unknown[];
			hasMore?: boolean;
			limit?: number;
			page?: number;
			pagination: {
				hasNextPage: boolean;
				page: number;
				totalPages: number;
			};
			rootFolders: unknown[];
			total?: number;
		}>;
		updateCapSharing: (
			id: string,
			input: { public: boolean },
		) => Promise<unknown>;
	};
	refresh: () => Promise<void>;
};

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type JsonNode = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;

const createAuth = (): AuthStub => ({
	status: "signedIn",
	apiKey: "api-key",
	bootstrap: {
		activeOrganizationId: "org_123",
		user: {
			email: "richie@cap.so",
			name: "Richie",
		},
	},
	client: {
		createFolder: vi.fn(
			(input: { color?: string; name: string; spaceId?: string }) =>
				Promise.resolve({
					id: "folder_123",
					name: input.name,
					color: input.color ?? "normal",
					parentId: null,
					videoCount: 0,
				}),
		),
		getCap: () =>
			Promise.resolve({
				cap: {
					upload: null,
				},
			}),
		getCapStatuses: () => Promise.resolve({ caps: [] }),
		listCaps: () =>
			Promise.resolve({
				caps: [],
				collectionTotal: 45,
				folders: [],
				pagination: {
					hasNextPage: false,
					page: 1,
					totalPages: 1,
				},
				rootFolders: [],
				total: 0,
			}),
		updateCapSharing: vi.fn((id: string, input: { public: boolean }) =>
			Promise.resolve({
				id,
				public: input.public,
			}),
		),
	},
	refresh: () => Promise.resolve(),
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

const uploadQueueState = vi.hoisted(
	(): {
		value: {
			items: Array<{
				capId: string | null;
				contentType: string;
				createdAt: string;
				error: string | null;
				fileName: string;
				folderId: string | null;
				id: string;
				localUri: string;
				organizationId: string | null;
				progress: number;
				processingMessage?: string | null;
				rawFileKey: string | null;
				size: number;
				durationSeconds?: number;
				status: "complete" | "failed" | "processing" | "queued" | "uploading";
				updatedAt: string;
			}>;
		};
	} => ({
		value: {
			items: [],
		},
	}),
);

const uploadQueueActionsState = vi.hoisted((): { value: unknown[] } => ({
	value: [],
}));

const recordingUploadState = vi.hoisted(() => ({
	libraryRevision: 0,
}));

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

const propMatches = (actual: unknown, expected: unknown): boolean => {
	if (
		expected &&
		typeof expected === "object" &&
		!Array.isArray(expected) &&
		actual &&
		typeof actual === "object" &&
		!Array.isArray(actual)
	) {
		return Object.entries(expected).every(
			([key, value]) => (actual as Record<string, unknown>)[key] === value,
		);
	}

	return actual === expected;
};

const hasProps = (
	node: JsonNode,
	expected: Record<string, unknown>,
): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some((item) => hasProps(item, expected));
	if (
		Object.entries(expected).every(([key, value]) =>
			propMatches(node.props[key], value),
		)
	) {
		return true;
	}
	return node.children?.some((child) => hasProps(child, expected)) ?? false;
};

const hasStyle = (
	node: JsonNode,
	expected: Record<string, unknown>,
): boolean => {
	if (!node || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some((item) => hasStyle(item, expected));
	const style =
		typeof node.props.style === "function"
			? node.props.style({ pressed: false })
			: node.props.style;
	const resolved = Array.isArray(style)
		? Object.assign({}, ...style.filter(Boolean))
		: style;
	if (
		resolved &&
		Object.entries(expected).every(([key, value]) => resolved[key] === value)
	) {
		return true;
	}
	return node.children?.some((child) => hasStyle(child, expected)) ?? false;
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
		ActivityIndicator: createHost("ActivityIndicator"),
		Alert: {
			alert: vi.fn(),
			prompt: vi.fn(),
		},
		AppState: {
			addEventListener: vi.fn(() => ({
				remove: vi.fn(),
			})),
		},
		Linking: {
			openSettings: vi.fn(),
		},
		Modal: createHost("Modal"),
		Platform: {
			OS: "ios",
			select: <T,>(values: { default?: T; ios?: T }) =>
				values.ios ?? values.default,
		},
		Pressable: createHost("Pressable"),
		RefreshControl: createHost("RefreshControl"),
		ScrollView: createHost("ScrollView"),
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
		Switch: createHost("Switch"),
		Text: createHost("Text"),
		TextInput: createHost("TextInput"),
		View: createHost("View"),
	};
});

vi.mock("@shopify/flash-list", async () => {
	const React = await import("react");
	return {
		FlashList: ({
			data,
			ListEmptyComponent,
			ListFooterComponent,
			ListHeaderComponent,
			onEndReached,
			renderItem,
			stickyHeaderIndices,
		}: {
			data?: unknown[];
			ListEmptyComponent?: ReactNode;
			ListFooterComponent?: ReactNode;
			ListHeaderComponent?: ReactNode;
			onEndReached?: () => void;
			renderItem?: (info: { index: number; item: unknown }) => ReactNode;
			stickyHeaderIndices?: number[];
		}) =>
			React.createElement(
				"FlashList",
				{ data, onEndReached, stickyHeaderIndices },
				ListHeaderComponent,
				data && data.length > 0
					? data.map((item, index) =>
							React.createElement(
								React.Fragment,
								{ key: index },
								renderItem?.({ item, index }),
							),
						)
					: ListEmptyComponent,
				ListFooterComponent,
			),
	};
});

vi.mock("expo-clipboard", () => ({
	setStringAsync: vi.fn(),
}));

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		router: {
			push: vi.fn(),
		},
		useFocusEffect: (callback: Parameters<typeof React.useEffect>[0]) =>
			React.useEffect(callback, [callback]),
	};
});

vi.mock("expo-web-browser", () => ({
	openBrowserAsync: vi.fn(),
}));

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
	useAuth: () => authState.value,
}));

vi.mock("@/uploads/recording-upload-provider", () => ({
	useRecordingUploadLibraryRevision: () => recordingUploadState.libraryRevision,
}));

vi.mock("@/auth/SignInPanel", async () => {
	const React = await import("react");
	return {
		SignInPanel: () => React.createElement("SignInPanel"),
	};
});

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
				{ accessibilityLabel: label, onPress, ...props },
				children ?? label,
			),
	};
});

vi.mock("@/components/CapRefreshControl", async () => {
	const React = await import("react");
	return {
		CapRefreshControl: (props: { [key: string]: unknown }) =>
			React.createElement("CapRefreshControl", props),
		CapRefreshOverlay: (props: { [key: string]: unknown }) =>
			React.createElement("CapRefreshOverlay", props),
	};
});

vi.mock("@/components/Screen", async () => {
	const React = await import("react");

	return {
		Screen: ({
			children,
			loading,
			subtitle,
			title,
		}: {
			children?: ReactNode;
			loading?: boolean;
			subtitle?: string | null;
			title?: string;
		}) =>
			React.createElement(
				"Screen",
				{ title },
				title ? React.createElement("Text", null, title) : null,
				subtitle ? React.createElement("Text", null, subtitle) : null,
				loading ? React.createElement("Text", null, "Loading") : children,
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

vi.mock("@/components/CapCard", async () => {
	const React = await import("react");
	return {
		CapCard: (props: HostProps) => React.createElement("CapCard", props),
	};
});

vi.mock("@/components/OrgSwitcher", async () => {
	const React = await import("react");
	return {
		OrgSwitcher: () => React.createElement("OrgSwitcher"),
	};
});

vi.mock("expo-symbols", () => ({
	SymbolView: () => null,
}));

vi.mock("react-native-svg", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		default: createHost("Svg"),
		Path: createHost("Path"),
		Rect: createHost("Rect"),
	};
});

vi.mock("@/theme", () => ({
	colors: {
		appBackground: "#f9f9f9",
		black: "#000000",
		blackAlpha40: "rgba(18, 22, 31, 0.4)",
		blue11: "#0d74ce",
		blue3: "#edf6ff",
		blue6: "#acd8fc",
		blue9: "#0090ff",
		buttonBlue: "#2563eb",
		buttonBlueBorder: "#1e40af",
		glass: "rgba(252, 252, 252, 0.72)",
		gray1: "#fcfcfc",
		gray10: "#838383",
		gray12: "#202020",
		gray2: "#f9f9f9",
		gray3: "#f0f0f0",
		gray4: "#e8e8e8",
		gray5: "#e0e0e0",
		gray6: "#d9d9d9",
		gray9: "#8d8d8d",
		red1: "#fffcfc",
		red3: "#feebec",
		red6: "#fdbdbe",
		red9: "#e5484d",
		white: "#ffffff",
		yellow3: "#fffab8",
		yellow5: "#ffe770",
		yellow9: "#f5d90a",
	},
	fonts: {
		bold: "NeueMontreal-Bold",
		medium: "NeueMontreal-Medium",
		regular: "NeueMontreal-Regular",
	},
	radius: {
		full: 999,
		lg: 16,
		md: 12,
		sm: 8,
		xl: 20,
		xs: 6,
	},
	shadows: {
		card: {},
		popover: {},
	},
	squircle: {
		borderCurve: "continuous",
	},
}));

vi.mock("expo-document-picker", () => ({
	getDocumentAsync: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => ({
	documentDirectory: "file:///tmp/",
	downloadAsync: vi.fn(),
}));

vi.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: vi.fn(),
	requestMediaLibraryPermissionsAsync: vi.fn(),
}));

vi.mock("expo-media-library", () => ({
	requestPermissionsAsync: vi.fn(),
	saveToLibraryAsync: vi.fn(),
}));

vi.mock("@/uploads/runMobileUpload", () => ({
	runMobileUpload: vi.fn(),
}));

vi.mock("@/uploads/uploadQueue", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/uploads/uploadQueue")>();

	return {
		...actual,
		emptyUploadQueue: uploadQueueState.value,
		uploadProgressPercent: (progress: number) => Math.round(progress * 100),
		uploadQueueReducer: (state: { items: unknown[] }, action: unknown) => {
			uploadQueueActionsState.value.push(action);
			return state;
		},
		uploadQueueStatusText: (item: {
			processingMessage?: string | null;
			progress: number;
			status: string;
		}) => {
			if (item.status === "complete") return "Ready to view";
			if (item.status === "failed") return "Upload failed";
			if (item.status === "processing") {
				return item.processingMessage ?? "Finishing up";
			}
			if (item.status === "uploading") {
				return `Uploading ${Math.round(item.progress * 100)}%`;
			}
			return "Queued";
		},
	};
});

describe("upload and dashboard visibility", () => {
	beforeEach(() => {
		vi.useRealTimers();
		authState.value = createAuth();
		recordingUploadState.libraryRevision = 0;
		uploadQueueState.value.items = [];
		uploadQueueActionsState.value = [];
	});

	it("shows native upload entry points", async () => {
		const tree = await renderTree(React.createElement(UploadScreen));

		expect(getTextNodes(tree)).toContain("Import");
		expect(getTextNodes(tree)).toContain("Upload File");
		expect(getTextNodes(tree)).toContain("Browse Files");
		expect(getTextNodes(tree)).toContain("Photos");
		expect(getTextNodes(tree)).toContain("Import from Loom");
		expect(getTextNodes(tree)).toContain("MP4, MOV, AVI, MKV, WebM, or M4V");
		expect(hasStyle(tree, { height: 128, backgroundColor: "#f0f0f0" })).toBe(
			true,
		);
		expect(
			hasProps(tree, {
				accessibilityHint: "Opens upload source options",
				accessibilityLabel: "Choose upload source",
				accessibilityState: { busy: false, disabled: false },
				accessibilityValue: {
					text: "MP4, MOV, AVI, MKV, WebM, or M4V",
				},
			}),
		).toBe(true);
		expect(
			hasProps(tree, {
				accessibilityHint: "Opens native Loom import",
				accessibilityLabel: "Open Loom import",
			}),
		).toBe(true);
		expect(
			hasProps(tree, {
				accessibilityHint: "Opens the native file picker",
				accessibilityLabel: "Browse Files",
			}),
		).toBe(true);
		expect(
			hasProps(tree, {
				accessibilityHint: "Opens your photo library",
				accessibilityLabel: "Photos",
			}),
		).toBe(true);
	});

	it("opens the native iOS upload source sheet", async () => {
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [uploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Choose upload source",
		});
		if (!uploadSource) throw new Error("Upload source button was not rendered");

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			uploadSource.props.onPress();
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 3,
				options: ["Browse Files", "Photos", "Import from Loom", "Cancel"],
				tintColor: "#0d74ce",
				title: "Upload File",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);

		const [, callback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!callback) throw new Error("Upload source callback was not set");
		const { router } = await import("expo-router");
		vi.mocked(router.push).mockClear();

		await act(async () => {
			callback(2);
		});

		expect(router.push).toHaveBeenCalledWith("/loom-import");
	});

	it("opens native Loom import", async () => {
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [loomAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import from Loom",
		});
		const [loomImport] = renderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		if (!loomAction) throw new Error("Loom upload action was not rendered");
		if (!loomImport) throw new Error("Loom import card was not rendered");

		const { router } = await import("expo-router");
		vi.mocked(router.push).mockClear();

		expect(loomAction.props.accessibilityHint).toBe("Opens native Loom import");

		await act(async () => {
			loomAction.props.onPress();
		});

		expect(router.push).toHaveBeenCalledWith("/loom-import");
		vi.mocked(router.push).mockClear();

		await act(async () => {
			loomImport.props.onPress();
		});

		expect(router.push).toHaveBeenCalledWith("/loom-import");
	});

	it("locks upload sources while the file picker is opening", async () => {
		const DocumentPicker = await import("expo-document-picker");
		let resolvePicker:
			| ((
					value: Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>,
			  ) => void)
			| null = null;
		vi.mocked(DocumentPicker.getDocumentAsync).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolvePicker = resolve;
				}),
		);
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			void browseButton.props.onPress();
			await Promise.resolve();
		});

		const [uploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Opening Files",
		});
		const [loadingBrowseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		const [photosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Photos",
		});
		const [loomAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import from Loom",
		});
		const [loomImport] = renderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		if (
			!uploadSource ||
			!loadingBrowseButton ||
			!photosButton ||
			!loomAction ||
			!loomImport
		) {
			throw new Error("Upload source controls were not rendered");
		}

		expect(getTextNodes(renderer.toJSON())).toContain("Opening Files");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Opening Files...");
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Choose a video from Files.",
		);
		expect(uploadSource.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(uploadSource.props.accessibilityValue).toEqual({
			text: "Opening native file picker",
		});
		expect(uploadSource.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(uploadSource.props.disabled).toBe(true);
		expect(resolveStyle(uploadSource.props.style)).toMatchObject({
			opacity: 0.58,
		});
		expect(loadingBrowseButton.props.loading).toBe(true);
		expect(loadingBrowseButton.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(loadingBrowseButton.props.accessibilityValue).toEqual({
			text: "Opening native file picker",
		});
		expect(photosButton.props.accessibilityHint).toBe(
			"Another upload source is opening",
		);
		expect(photosButton.props.accessibilityValue).toEqual({
			text: "Opening native file picker",
		});
		expect(photosButton.props.disabled).toBe(true);
		expect(loomAction.props.accessibilityHint).toBe(
			"Another upload source is opening",
		);
		expect(loomAction.props.accessibilityValue).toEqual({
			text: "Opening native file picker",
		});
		expect(loomAction.props.disabled).toBe(true);
		expect(loomImport.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(loomImport.props.accessibilityValue).toEqual({
			text: "Opening native file picker",
		});
		expect(loomImport.props.disabled).toBe(true);

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		const ImagePicker = await import("expo-image-picker");
		const requestMediaLibraryPermissionsAsync = vi.mocked(
			ImagePicker.requestMediaLibraryPermissionsAsync,
		);
		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		showActionSheetWithOptions.mockClear();
		requestMediaLibraryPermissionsAsync.mockClear();
		openBrowserAsync.mockClear();

		await act(async () => {
			uploadSource.props.onPress();
			photosButton.props.onPress();
			loomAction.props.onPress();
			loomImport.props.onPress();
		});

		expect(showActionSheetWithOptions).not.toHaveBeenCalled();
		expect(requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
		expect(openBrowserAsync).not.toHaveBeenCalled();
		expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolvePicker?.({
				assets: null,
				canceled: true,
			} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
			await Promise.resolve();
		});
	});

	it("shows the active Photos source as loading while the photo picker is opening", async () => {
		const ImagePicker = await import("expo-image-picker");
		const requestMediaLibraryPermissionsAsync = vi.mocked(
			ImagePicker.requestMediaLibraryPermissionsAsync,
		);
		let resolvePermission:
			| ((
					value: Awaited<
						ReturnType<typeof ImagePicker.requestMediaLibraryPermissionsAsync>
					>,
			  ) => void)
			| null = null;
		requestMediaLibraryPermissionsAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolvePermission = resolve;
				}),
		);
		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [photosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Photos",
		});
		if (!photosButton) throw new Error("Photos button was not rendered");

		await act(async () => {
			void photosButton.props.onPress();
			await Promise.resolve();
		});

		const [uploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Opening Photos",
		});
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		const [loadingPhotosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Photos",
		});
		const [loomAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import from Loom",
		});
		const [loomImport] = renderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		if (
			!uploadSource ||
			!browseButton ||
			!loadingPhotosButton ||
			!loomAction ||
			!loomImport
		) {
			throw new Error("Upload source controls were not rendered");
		}

		expect(getTextNodes(renderer.toJSON())).toContain("Opening Photos");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Opening Photos...");
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Choose a video from Photos.",
		);
		expect(uploadSource.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(uploadSource.props.accessibilityValue).toEqual({
			text: "Opening native photo picker",
		});
		expect(uploadSource.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(uploadSource.props.disabled).toBe(true);
		expect(resolveStyle(uploadSource.props.style)).toMatchObject({
			opacity: 0.58,
		});
		expect(browseButton.props.accessibilityHint).toBe(
			"Another upload source is opening",
		);
		expect(browseButton.props.accessibilityValue).toEqual({
			text: "Opening native photo picker",
		});
		expect(browseButton.props.disabled).toBe(true);
		expect(loadingPhotosButton.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(loadingPhotosButton.props.accessibilityValue).toEqual({
			text: "Opening native photo picker",
		});
		expect(loadingPhotosButton.props.loading).toBe(true);
		expect(loadingPhotosButton.props.disabled).toBe(false);
		expect(loomAction.props.accessibilityHint).toBe(
			"Another upload source is opening",
		);
		expect(loomAction.props.accessibilityValue).toEqual({
			text: "Opening native photo picker",
		});
		expect(loomAction.props.disabled).toBe(true);
		expect(loomImport.props.accessibilityHint).toBe(
			"Upload source picker is opening",
		);
		expect(loomImport.props.accessibilityValue).toEqual({
			text: "Opening native photo picker",
		});
		expect(loomImport.props.disabled).toBe(true);

		await act(async () => {
			resolvePermission?.({
				granted: false,
			} as Awaited<
				ReturnType<typeof ImagePicker.requestMediaLibraryPermissionsAsync>
			>);
			await Promise.resolve();
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 1,
				message: "Allow Cap to read videos from Photos before uploading.",
				options: ["Open Settings", "Cancel"],
				title: "Photos access needed",
			}),
			expect.any(Function),
		);
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Upload source unavailable",
		);
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Allow Cap to read videos from Photos before uploading.",
		);
		const [failedUploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload source unavailable",
		});
		const [retryPhotosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Retry Photos",
		});
		if (!failedUploadSource)
			throw new Error("Upload source error state was not rendered");
		if (!retryPhotosButton)
			throw new Error("Retry Photos button was not rendered");
		expect(failedUploadSource.props.accessibilityValue).toEqual({
			text: "Allow Cap to read videos from Photos before uploading.",
		});
		expect(retryPhotosButton.props.accessibilityHint).toBe(
			"Allow Cap to read videos from Photos before uploading.",
		);
		expect(retryPhotosButton.props.accessibilityValue).toEqual({
			text: "Allow Cap to read videos from Photos before uploading.",
		});
		expect(retryPhotosButton.props.disabled).toBe(false);
	});

	it("deduplicates stale upload source actions while the file picker is opening", async () => {
		const DocumentPicker = await import("expo-document-picker");
		const getDocumentAsync = vi.mocked(DocumentPicker.getDocumentAsync);
		let resolvePicker:
			| ((
					value: Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>,
			  ) => void)
			| null = null;
		getDocumentAsync.mockClear();
		getDocumentAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolvePicker = resolve;
				}),
		);
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [uploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Choose upload source",
		});
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		const [photosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Photos",
		});
		const [loomAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import from Loom",
		});
		const [loomImport] = renderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		if (
			!uploadSource ||
			!browseButton ||
			!photosButton ||
			!loomAction ||
			!loomImport
		) {
			throw new Error("Upload source controls were not rendered");
		}

		await act(async () => {
			void browseButton.props.onPress();
			await Promise.resolve();
		});

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		const ImagePicker = await import("expo-image-picker");
		const requestMediaLibraryPermissionsAsync = vi.mocked(
			ImagePicker.requestMediaLibraryPermissionsAsync,
		);
		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		showActionSheetWithOptions.mockClear();
		requestMediaLibraryPermissionsAsync.mockClear();
		openBrowserAsync.mockClear();

		await act(async () => {
			uploadSource.props.onPress();
			browseButton.props.onPress();
			photosButton.props.onPress();
			loomAction.props.onPress();
			loomImport.props.onPress();
			await Promise.resolve();
		});

		expect(getDocumentAsync).toHaveBeenCalledTimes(1);
		expect(showActionSheetWithOptions).not.toHaveBeenCalled();
		expect(requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
		expect(openBrowserAsync).not.toHaveBeenCalled();

		await act(async () => {
			resolvePicker?.({
				assets: null,
				canceled: true,
			} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
			await Promise.resolve();
		});
	});

	it("locks Loom import while a device upload is active", async () => {
		const DocumentPicker = await import("expo-document-picker");
		const { runMobileUpload } = await import("@/uploads/runMobileUpload");
		const uploadStartedAt = 1_763_440_800_000;
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(uploadStartedAt);
		let resolveUpload:
			| ((value: Awaited<ReturnType<typeof runMobileUpload>>) => void)
			| null = null;
		uploadQueueState.value.items = [
			{
				capId: null,
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: null,
				fileName: "launch-review.mp4",
				folderId: null,
				id: `${uploadStartedAt}-launch-review.mp4`,
				localUri: "file:///tmp/launch-review.mp4",
				organizationId: "org_123",
				progress: 0,
				processingMessage: null,
				rawFileKey: null,
				size: 12_400_000,
				status: "queued",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
			assets: [
				{
					mimeType: "video/mp4",
					name: "launch-review.mp4",
					size: 12_400_000,
					uri: "file:///tmp/launch-review.mp4",
				},
			],
			canceled: false,
		} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
		vi.mocked(runMobileUpload).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveUpload = resolve;
				}),
		);
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			void browseButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const [uploadSource] = renderer.root.findAllByProps({
			accessibilityLabel: "Choose upload source",
		});
		const [loomImport] = renderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		const [activeBrowseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		const [photosButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Photos",
		});
		const [loomAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import from Loom",
		});
		if (!uploadSource) throw new Error("Upload source button was not rendered");
		if (!loomImport) throw new Error("Loom import card was not rendered");
		if (!activeBrowseButton)
			throw new Error("Browse Files button was not rendered");
		if (!photosButton) throw new Error("Photos button was not rendered");
		if (!loomAction) throw new Error("Loom upload action was not rendered");
		const WebBrowser = await import("expo-web-browser");
		const openBrowserAsync = vi.mocked(WebBrowser.openBrowserAsync);
		openBrowserAsync.mockClear();

		expect(getTextNodes(renderer.toJSON())).toContain("Upload File");
		expect(getTextNodes(renderer.toJSON())).not.toContain("Preparing upload");
		expect(getTextNodes(renderer.toJSON()).join("")).toContain(
			"Preparing upload · 12 MB",
		);
		expect(getTextNodes(renderer.toJSON())).toContain("Import from Loom");
		expect(getTextNodes(renderer.toJSON())).toContain(
			"Finish preparing this upload before importing from Loom.",
		);
		expect(uploadSource.props.accessibilityHint).toBe("Preparing upload");
		expect(uploadSource.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(uploadSource.props.disabled).toBe(true);
		expect(resolveStyle(uploadSource.props.style)).toMatchObject({
			opacity: 0.58,
		});
		expect(activeBrowseButton.props.loading).toBe(false);
		expect(activeBrowseButton.props.accessibilityHint).toBe("Preparing upload");
		expect(activeBrowseButton.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(activeBrowseButton.props.disabled).toBe(true);
		expect(photosButton.props.loading).toBe(false);
		expect(photosButton.props.accessibilityHint).toBe("Preparing upload");
		expect(photosButton.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(photosButton.props.disabled).toBe(true);
		expect(loomAction.props.loading).toBe(false);
		expect(loomAction.props.accessibilityHint).toBe("Preparing upload");
		expect(loomAction.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(loomAction.props.disabled).toBe(true);
		expect(loomImport.props.accessibilityHint).toBe("Preparing upload");
		expect(loomImport.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(loomImport.props.accessibilityState).toEqual({
			busy: true,
			disabled: true,
		});
		expect(loomImport.props.disabled).toBe(true);

		await act(async () => {
			loomImport.props.onPress();
		});

		expect(openBrowserAsync).not.toHaveBeenCalled();

		await act(async () => {
			resolveUpload?.({
				id: "video_123",
			} as Awaited<ReturnType<typeof runMobileUpload>>);
			await Promise.resolve();
		});
		dateNow.mockRestore();
	});

	it("locks inactive upload queue rows while a device upload is active", async () => {
		uploadQueueState.value.items = [
			{
				capId: null,
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: "Network unavailable",
				fileName: "failed-upload.mp4",
				folderId: null,
				id: "failed-upload",
				localUri: "file:///tmp/failed-upload.mp4",
				organizationId: "org_123",
				progress: 0.42,
				rawFileKey: null,
				size: 124_000,
				durationSeconds: 125,
				status: "failed",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		const DocumentPicker = await import("expo-document-picker");
		const { runMobileUpload } = await import("@/uploads/runMobileUpload");
		let resolveUpload:
			| ((value: Awaited<ReturnType<typeof runMobileUpload>>) => void)
			| null = null;
		vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
			assets: [
				{
					mimeType: "video/mp4",
					name: "launch-review.mp4",
					size: 12_400_000,
					uri: "file:///tmp/launch-review.mp4",
				},
			],
			canceled: false,
		} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
		vi.mocked(runMobileUpload).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveUpload = resolve;
				}),
		);
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			void browseButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const [queueRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload failed-upload.mp4",
		});
		const [retryButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Retry upload failed-upload.mp4",
		});
		const queueMenus = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for failed-upload.mp4",
		});
		const [queueMenu] = queueMenus;
		if (!queueRow) throw new Error("Upload queue row was not rendered");
		if (!retryButton) throw new Error("Retry button was not rendered");
		if (!queueMenu) throw new Error("Upload queue menu was not rendered");

		expect(queueRow.props.accessibilityHint).toBe(
			"Another upload is in progress",
		);
		expect(queueRow.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		expect(queueRow.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(queueRow.props.disabled).toBe(true);
		expect(retryButton.props.disabled).toBe(true);
		expect(retryButton.props.accessibilityHint).toBe(
			"Another upload is in progress",
		);
		expect(retryButton.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(queueMenu.props.accessibilityHint).toBe(
			"Another upload is in progress",
		);
		expect(queueMenu.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		expect(queueMenu.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(queueMenu.props.disabled).toBe(true);

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			queueRow.props.onPress();
			retryButton.props.onPress({ stopPropagation: vi.fn() });
			queueMenu.props.onPress({ stopPropagation: vi.fn() });
		});

		expect(showActionSheetWithOptions).not.toHaveBeenCalled();
		expect(uploadQueueActionsState.value).not.toContainEqual(
			expect.objectContaining({
				id: "failed-upload",
				type: "retry",
			}),
		);

		await act(async () => {
			resolveUpload?.({
				id: "video_123",
			} as Awaited<ReturnType<typeof runMobileUpload>>);
			await Promise.resolve();
		});
	});

	it("locks stale upload queue view actions while a device upload is active", async () => {
		uploadQueueState.value.items = [
			{
				capId: "video_complete",
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: null,
				fileName: "processed-upload.mp4",
				folderId: null,
				id: "processed-upload",
				localUri: "file:///tmp/processed-upload.mp4",
				organizationId: "org_123",
				progress: 1,
				rawFileKey: "raw-file-key",
				size: 124_000,
				durationSeconds: 125,
				status: "complete",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [queueRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload processed-upload.mp4",
		});
		const [queueMenu] = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for processed-upload.mp4",
		});
		const [viewButton] = renderer.root.findAllByProps({
			accessibilityLabel: "View upload processed-upload.mp4",
		});
		if (!queueRow) throw new Error("Upload queue row was not rendered");
		if (!queueMenu) throw new Error("Upload queue menu was not rendered");
		if (!viewButton) throw new Error("View button was not rendered");
		expect(queueRow.props.accessibilityHint).toBe(
			"Ready to view. Opens upload actions",
		);
		expect(queueMenu.props.accessibilityHint).toBe(
			"Opens view and remove actions",
		);
		expect(queueRow.props.accessibilityValue).toEqual({
			text: "Ready to view · 124 KB · 2 mins",
		});

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			queueRow.props.onPress();
		});

		const [, callback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!callback) throw new Error("Upload queue action callback was not set");

		const DocumentPicker = await import("expo-document-picker");
		const { runMobileUpload } = await import("@/uploads/runMobileUpload");
		let resolveUpload:
			| ((value: Awaited<ReturnType<typeof runMobileUpload>>) => void)
			| null = null;
		vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
			assets: [
				{
					mimeType: "video/mp4",
					name: "launch-review.mp4",
					size: 12_400_000,
					uri: "file:///tmp/launch-review.mp4",
				},
			],
			canceled: false,
		} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
		vi.mocked(runMobileUpload).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveUpload = resolve;
				}),
		);
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			void browseButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
		});

		const { router } = await import("expo-router");
		const push = vi.mocked(router.push);
		push.mockClear();
		const [lockedViewButton] = renderer.root.findAllByProps({
			accessibilityLabel: "View upload processed-upload.mp4",
		});
		const [lockedQueueMenu] = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for processed-upload.mp4",
		});
		if (!lockedViewButton) throw new Error("View button was not rendered");
		if (!lockedQueueMenu) throw new Error("Upload queue menu was not rendered");
		expect(lockedViewButton.props.accessibilityHint).toBe(
			"Another upload is in progress",
		);
		expect(lockedViewButton.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(lockedViewButton.props.disabled).toBe(true);
		expect(lockedQueueMenu.props.accessibilityHint).toBe(
			"Another upload is in progress",
		);
		expect(lockedQueueMenu.props.accessibilityState).toEqual({
			busy: false,
			disabled: true,
		});
		expect(lockedQueueMenu.props.accessibilityValue).toEqual({
			text: "Preparing upload launch-review.mp4",
		});
		expect(lockedQueueMenu.props.disabled).toBe(true);

		showActionSheetWithOptions.mockClear();
		await act(async () => {
			viewButton.props.onPress({ stopPropagation: vi.fn() });
			lockedQueueMenu.props.onPress({ stopPropagation: vi.fn() });
			callback(0);
		});

		expect(push).not.toHaveBeenCalled();
		expect(showActionSheetWithOptions).not.toHaveBeenCalled();

		await act(async () => {
			resolveUpload?.({
				id: "video_123",
			} as Awaited<ReturnType<typeof runMobileUpload>>);
			await Promise.resolve();
		});
	});

	it("announces processing upload queue rows with their current status", async () => {
		uploadQueueState.value.items = [
			{
				capId: "video_processing",
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: null,
				fileName: "processing-upload.mp4",
				folderId: null,
				id: "processing-upload",
				localUri: "file:///tmp/processing-upload.mp4",
				organizationId: "org_123",
				progress: 0.42,
				processingMessage: "Processing frames",
				rawFileKey: "raw-file-key",
				size: 124_000,
				durationSeconds: 125,
				status: "processing",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const tree = renderer.toJSON();
		const [queueRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload processing-upload.mp4",
		});
		const [queueMenu] = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for processing-upload.mp4",
		});
		const [viewButton] = renderer.root.findAllByProps({
			accessibilityLabel: "View upload processing-upload.mp4",
		});
		if (!queueRow) throw new Error("Processing upload row was not rendered");
		if (!queueMenu) throw new Error("Upload queue menu was not rendered");
		if (!viewButton) throw new Error("View button was not rendered");

		expect(getTextNodes(tree).join("")).toContain(
			"Processing frames · 124 KB · 2 mins",
		);
		expect(queueRow.props.accessibilityHint).toBe(
			"Processing frames. Opens upload actions",
		);
		expect(queueMenu.props.accessibilityHint).toBe(
			"Opens view and remove actions",
		);
		expect(queueRow.props.accessibilityValue).toEqual({
			text: "Processing frames · 124 KB · 2 mins",
		});
		expect(
			hasProps(tree, {
				accessibilityLabel: "Upload progress for processing-upload.mp4",
				accessibilityRole: "progressbar",
				accessibilityValue: {
					max: 100,
					min: 0,
					now: 42,
					text: "42%",
				},
			}),
		).toBe(true);
		expect(viewButton.props.accessibilityHint).toBe("Opens the uploaded Cap");
	});

	it("shows queued upload rows without premature progress", async () => {
		uploadQueueState.value.items = [
			{
				capId: null,
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: null,
				fileName: "queued-upload.mp4",
				folderId: null,
				id: "queued-upload",
				localUri: "file:///tmp/queued-upload.mp4",
				organizationId: "org_123",
				progress: 0,
				processingMessage: null,
				rawFileKey: null,
				size: 124_000,
				durationSeconds: 125,
				status: "queued",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const tree = renderer.toJSON();
		const [queueRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload queued-upload.mp4",
		});
		const [queueMenu] = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for queued-upload.mp4",
		});
		if (!queueRow) throw new Error("Queued upload row was not rendered");
		if (!queueMenu) throw new Error("Upload queue menu was not rendered");

		expect(getTextNodes(tree).join("")).toContain("Queued · 124 KB · 2 mins");
		expect(queueRow.props.accessibilityHint).toBe(
			"Queued. Opens upload actions",
		);
		expect(queueRow.props.accessibilityValue).toEqual({
			text: "Queued · 124 KB · 2 mins",
		});
		expect(queueMenu.props.accessibilityHint).toBe("Opens remove action");
		expect(
			hasProps(tree, {
				accessibilityLabel: "Upload progress for queued-upload.mp4",
				accessibilityRole: "progressbar",
			}),
		).toBe(false);

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			queueMenu.props.onPress({ stopPropagation: vi.fn() });
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 1,
				destructiveButtonIndex: 0,
				message: "Queued · 124 KB · 2 mins",
				options: ["Remove from Queue", "Cancel"],
				title: "queued-upload.mp4",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);
	});

	it("keeps uploaded files processing when the library refresh fails", async () => {
		const auth = createAuth();
		auth.refresh = vi.fn(() => Promise.reject(new Error("Refresh failed")));
		authState.value = auth;
		const DocumentPicker = await import("expo-document-picker");
		const { runMobileUpload } = await import("@/uploads/runMobileUpload");
		vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
			assets: [
				{
					mimeType: "video/mp4",
					name: "launch-review.mp4",
					size: 12_400_000,
					uri: "file:///tmp/launch-review.mp4",
				},
			],
			canceled: false,
		} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
		vi.mocked(runMobileUpload).mockResolvedValueOnce({
			id: "video_123",
		} as Awaited<ReturnType<typeof runMobileUpload>>);
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const [browseButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			await browseButton.props.onPress();
			await Promise.resolve();
		});

		expect(uploadQueueActionsState.value).toContainEqual(
			expect.objectContaining({
				progress: 0,
				type: "processing",
			}),
		);
		expect(
			uploadQueueActionsState.value.some(
				(action) =>
					typeof action === "object" &&
					action !== null &&
					"type" in action &&
					action.type === "fail",
			),
		).toBe(false);
	});

	it("completes uploaded files when the final processing refresh fails", async () => {
		vi.useFakeTimers();
		try {
			const auth = createAuth();
			auth.refresh = vi.fn(() => Promise.reject(new Error("Refresh failed")));
			auth.client.getCap = vi.fn(() =>
				Promise.resolve({
					cap: {
						upload: null,
					},
				}),
			);
			authState.value = auth;
			const DocumentPicker = await import("expo-document-picker");
			const { runMobileUpload } = await import("@/uploads/runMobileUpload");
			vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
				assets: [
					{
						mimeType: "video/mp4",
						name: "launch-review.mp4",
						size: 12_400_000,
						uri: "file:///tmp/launch-review.mp4",
					},
				],
				canceled: false,
			} as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);
			vi.mocked(runMobileUpload).mockResolvedValueOnce({
				id: "video_123",
			} as Awaited<ReturnType<typeof runMobileUpload>>);
			const renderer = await renderComponent(React.createElement(UploadScreen));
			const [browseButton] = renderer.root.findAllByProps({
				accessibilityLabel: "Browse Files",
			});
			if (!browseButton)
				throw new Error("Browse Files button was not rendered");

			await act(async () => {
				await browseButton.props.onPress();
				await Promise.resolve();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1500);
			});

			expect(auth.client.getCap).toHaveBeenCalledWith("video_123");
			expect(auth.refresh).toHaveBeenCalledTimes(2);
			expect(uploadQueueActionsState.value).toContainEqual(
				expect.objectContaining({
					type: "complete",
				}),
			);
			expect(
				uploadQueueActionsState.value.some(
					(action) =>
						typeof action === "object" &&
						action !== null &&
						"type" in action &&
						action.type === "fail",
				),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens the native iOS upload queue sheet", async () => {
		uploadQueueState.value.items = [
			{
				capId: null,
				contentType: "video/mp4",
				createdAt: "2026-05-18T10:00:00.000Z",
				error: "Network unavailable",
				fileName: "failed-upload.mp4",
				folderId: null,
				id: "failed-upload",
				localUri: "file:///tmp/failed-upload.mp4",
				organizationId: "org_123",
				progress: 0.42,
				rawFileKey: null,
				size: 124_000,
				durationSeconds: 125,
				status: "failed",
				updatedAt: "2026-05-18T10:00:00.000Z",
			},
		];
		const renderer = await renderComponent(React.createElement(UploadScreen));
		const tree = renderer.toJSON();
		const [queueMenu] = renderer.root.findAllByProps({
			accessibilityLabel: "More actions for failed-upload.mp4",
		});
		if (!queueMenu) throw new Error("Upload queue menu was not rendered");
		const [queueRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Upload failed-upload.mp4",
		});
		if (!queueRow) throw new Error("Upload queue row was not rendered");
		expect(getTextNodes(tree).join("")).toContain(
			"Upload failed · Network unavailable · 124 KB · 2 mins",
		);
		expect(queueMenu.props.hitSlop).toBe(6);
		expect(queueMenu.props.accessibilityHint).toBe(
			"Opens retry and remove actions",
		);
		expect(
			hasProps(tree, {
				accessibilityHint: "Upload failed. Opens upload actions",
				accessibilityLabel: "Upload failed-upload.mp4",
				accessibilityState: { busy: false, disabled: false },
			}),
		).toBe(true);
		expect(queueRow.props.accessibilityValue).toEqual({
			text: "Upload failed · Network unavailable · 124 KB · 2 mins",
		});
		expect(
			hasProps(tree, {
				accessibilityLabel: "Upload progress for failed-upload.mp4",
				accessibilityRole: "progressbar",
			}),
		).toBe(false);
		expect(hasProp(tree, "accessibilityRole", "alert")).toBe(true);

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		const menuStopPropagation = vi.fn();
		await act(async () => {
			queueMenu.props.onPress({ stopPropagation: menuStopPropagation });
		});

		expect(menuStopPropagation).toHaveBeenCalled();
		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 2,
				destructiveButtonIndex: 1,
				message: "Upload failed · Network unavailable · 124 KB · 2 mins",
				options: ["Retry", "Remove from Queue", "Cancel"],
				title: "failed-upload.mp4",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			queueRow.props.onPress();
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 2,
				destructiveButtonIndex: 1,
				message: "Upload failed · Network unavailable · 124 KB · 2 mins",
				options: ["Retry", "Remove from Queue", "Cancel"],
				title: "failed-upload.mp4",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);
	});

	it("announces picker errors as native alerts", async () => {
		const DocumentPicker = await import("expo-document-picker");
		vi.mocked(DocumentPicker.getDocumentAsync).mockRejectedValueOnce(
			new Error("Files unavailable"),
		);
		const uploadRenderer = await renderComponent(
			React.createElement(UploadScreen),
		);
		const [browseButton] = uploadRenderer.root.findAllByProps({
			accessibilityLabel: "Browse Files",
		});
		if (!browseButton) throw new Error("Browse Files button was not rendered");

		await act(async () => {
			await browseButton.props.onPress();
		});

		expect(getTextNodes(uploadRenderer.toJSON())).toContain(
			"Upload source unavailable",
		);
		expect(getTextNodes(uploadRenderer.toJSON())).toContain(
			"Files unavailable",
		);
		const [uploadSource] = uploadRenderer.root.findAllByProps({
			accessibilityLabel: "Upload source unavailable",
		});
		if (!uploadSource) throw new Error("Upload source button was not rendered");
		expect(uploadSource.props.accessibilityHint).toBe(
			"Retries upload source options",
		);
		expect(uploadSource.props.accessibilityValue).toEqual({
			text: "Files unavailable",
		});
		const [retryFilesButton] = uploadRenderer.root.findAllByProps({
			accessibilityLabel: "Retry Files",
		});
		if (!retryFilesButton)
			throw new Error("Retry Files button was not rendered");
		expect(retryFilesButton.props.accessibilityHint).toBe("Files unavailable");
		expect(retryFilesButton.props.disabled).toBe(false);
		const [loomImport] = uploadRenderer.root.findAllByProps({
			accessibilityLabel: "Open Loom import",
		});
		if (!loomImport) throw new Error("Loom import card was not rendered");
		expect(loomImport.props.accessibilityValue).toBeUndefined();
		expect(hasStyle(uploadRenderer.toJSON(), { color: "#e5484d" })).toBe(true);
		expect(
			hasProps(uploadRenderer.toJSON(), {
				accessibilityLiveRegion: "polite",
				accessibilityRole: "alert",
			}),
		).toBe(true);
	});

	it("shows dashboard record and import actions", async () => {
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(text).toContain("My Caps");
		expect(text).toContain("45 caps");
		const [screen] = renderer.root.findAll(
			(node) => String(node.type) === "Screen",
		);
		if (!screen) throw new Error("Dashboard screen was not rendered");
		expect(screen.props.title).toBeUndefined();
		expect(text.filter((item) => item === "New Folder").length).toBeGreaterThan(
			0,
		);
		expect(text).not.toContain("Record Video");
		expect(text).not.toContain("Import Video");
		expect(text.filter((item) => item === "Record")).toHaveLength(1);
		expect(text.filter((item) => item === "Import Media")).toHaveLength(1);
		const [recordAction] = renderer.root.findAll(
			(node) =>
				String(node.type) === "ActionButton" &&
				node.props.accessibilityLabel === "Record",
		);
		if (!recordAction)
			throw new Error("Dashboard record action was not rendered");
		const [importAction] = renderer.root.findAllByProps({
			accessibilityLabel: "Import Media",
		});
		if (!importAction)
			throw new Error("Dashboard import action was not rendered");
		expect(recordAction.props).toMatchObject({
			accessibilityHint: "Opens the camera recorder",
			symbol: "video.fill",
			variant: "dark",
		});
		expect(importAction.props.variant).toBe("secondary");
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Import Media" }),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Import" }),
		).toHaveLength(0);
		const [list] = renderer.root.findAll(
			(node) => String(node.type) === "FlashList",
		);
		if (!list) throw new Error("Dashboard list was not rendered");
		expect(list.props.stickyHeaderIndices).toEqual([0]);
		expect(
			(list.props.data as Array<{ type: string }>).map((item) => item.type),
		).toEqual(["space-switcher", "empty"]);
		expect(
			list.findAll((node) => String(node.type) === "OrgSwitcher").length,
		).toBeGreaterThan(0);
		expect(
			list.findAllByProps({ accessibilityLabel: "New Folder" }).length,
		).toBeGreaterThan(0);
		expect(
			list.findAllByProps({ accessibilityLabel: "Switch space" }).length,
		).toBeGreaterThan(0);
		expect(hasStyle(tree, { marginBottom: 40 })).toBe(true);
		expect(text).toContain("Welcome! Record or Import your first Cap");
		expect(hasProp(tree, "accessibilityLabel", "Cap logo")).toBe(true);
		expect(
			hasProps(tree, {
				accessibilityHint: "Opens import options",
				accessibilityLabel: "Import Media",
			}),
		).toBe(true);

		const { router } = await import("expo-router");
		const push = vi.mocked(router.push);
		push.mockClear();
		await act(async () => {
			recordAction.props.onPress();
		});
		expect(push).toHaveBeenCalledWith("/record");

		push.mockClear();
		await act(async () => {
			importAction.props.onPress();
		});
		expect(push).toHaveBeenCalledWith("/upload");
	});

	it("switches from My Caps into an available space", async () => {
		const auth = createAuth();
		auth.bootstrap.spaces = [
			{
				id: "org_123",
				name: "All Cap",
				iconUrl: null,
				kind: "organization",
				privacy: "Public",
				role: "owner",
				canManage: true,
				hasPassword: false,
			},
			{
				id: "space_123",
				name: "Product",
				iconUrl: null,
				kind: "space",
				privacy: "Private",
				role: "member",
				canManage: false,
				hasPassword: false,
			},
		];
		auth.client.listCaps = vi.fn(() =>
			Promise.resolve({
				caps: [],
				folders: [],
				pagination: {
					hasNextPage: false,
					page: 1,
					totalPages: 1,
				},
				rootFolders: [],
			}),
		);
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const [switcher] = renderer.root.findAllByProps({
			accessibilityLabel: "Switch space",
		});
		if (!switcher) throw new Error("Space switcher was not rendered");
		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			switcher.props.onPress();
		});

		const [options, select] = showActionSheetWithOptions.mock.calls[0] ?? [];
		expect(options).toMatchObject({
			disabledButtonIndices: [0],
			options: ["My Caps", "All Cap · Owner", "Product · Member", "Cancel"],
			title: "Space",
		});
		if (!select) throw new Error("Space action callback was not registered");

		await act(async () => {
			select(2);
			await Promise.resolve();
		});

		expect(auth.client.listCaps).toHaveBeenLastCalledWith(
			expect.objectContaining({ spaceId: "space_123" }),
		);
		const text = getTextNodes(renderer.toJSON());
		expect(text).toContain("Product");
		expect(text).toContain("No Caps in Product");
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "New Folder" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAll(
				(node) =>
					String(node.type) === "ActionButton" &&
					node.props.accessibilityLabel === "Record",
			),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Import Media" }),
		).toHaveLength(0);
	});

	it("announces dashboard load errors with a retry action", async () => {
		const auth = createAuth();
		auth.client.listCaps = vi.fn(() =>
			Promise.reject(new Error("Network unavailable")),
		);
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));

		await act(async () => {
			await Promise.resolve();
		});

		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(text).toContain("Unable to load Caps");
		expect(text).toContain("Network unavailable");
		expect(
			hasProps(tree, {
				accessibilityLabel: "Library error: Network unavailable",
				accessibilityLiveRegion: "polite",
				accessibilityRole: "alert",
			}),
		).toBe(true);

		const [retryButton] = renderer.root.findAllByProps({
			accessibilityLabel: "Try again",
		});
		if (!retryButton)
			throw new Error("Dashboard retry action was not rendered");
		expect(retryButton.props.accessibilityHint).toBe(
			"Reloads your Cap library",
		);

		await act(async () => {
			await retryButton.props.onPress();
			await Promise.resolve();
		});

		expect(auth.client.listCaps).toHaveBeenCalledTimes(2);
	});

	it("loads the next dashboard page without replacing visible Caps", async () => {
		const auth = createAuth();
		auth.client.listCaps = vi.fn((input?: { page?: number }) =>
			Promise.resolve({
				caps: [
					{
						id: input?.page === 2 ? "cap_2" : "cap_1",
						title: input?.page === 2 ? "Second Cap" : "First Cap",
						upload: null,
					},
				],
				folders: [],
				hasMore: input?.page !== 2,
				limit: 30,
				page: input?.page ?? 1,
				pagination: {
					hasNextPage: input?.page !== 2,
					page: input?.page ?? 1,
					totalPages: 2,
				},
				rootFolders: [],
				total: 2,
			}),
		);
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const [list] = renderer.root.findAll(
			(node) => String(node.type) === "FlashList",
		);
		if (!list) throw new Error("Dashboard list was not rendered");

		await act(async () => {
			await list.props.onEndReached();
		});

		expect(auth.client.listCaps).toHaveBeenLastCalledWith(
			expect.objectContaining({ limit: 30, page: 2 }),
		);
		const capCards = renderer.root.findAll((node) => {
			const cap = node.props.cap as { id?: string } | undefined;
			return (
				String(node.type) === "CapCard" &&
				(cap?.id === "cap_1" || cap?.id === "cap_2")
			);
		});
		expect(capCards.map((card) => card.props.cap.id)).toEqual([
			"cap_1",
			"cap_2",
		]);
		expect(capCards[0]?.props.thumbnailAuthorization).toBe("Bearer api-key");
	});

	it("refreshes a new recording until server processing finishes", async () => {
		vi.useFakeTimers();
		const auth = createAuth();
		const response = (upload: Record<string, unknown> | null) => ({
			caps: [
				{
					id: "cap_123",
					title: "Cap Recording",
					upload,
				},
			],
			folders: [],
			pagination: {
				hasNextPage: false,
				page: 1,
				totalPages: 1,
			},
			rootFolders: [],
		});
		auth.client.listCaps = vi
			.fn()
			.mockResolvedValueOnce({ ...response(null), caps: [] })
			.mockResolvedValueOnce(
				response({
					phase: "processing",
					processingError: null,
					processingMessage: "Muxing segments into MP4...",
					processingProgress: 25,
					total: 100,
					uploaded: 100,
				}),
			)
			.mockResolvedValue(response(null));
		auth.client.getCapStatuses = vi
			.fn()
			.mockResolvedValueOnce({
				caps: [
					{
						id: "cap_123",
						upload: {
							phase: "processing",
							processingError: null,
							processingMessage: "Generating thumbnail...",
							processingProgress: 70,
							total: 100,
							uploaded: 100,
						},
					},
				],
			})
			.mockResolvedValue({ caps: [{ id: "cap_123", upload: null }] });
		authState.value = auth;

		const renderer = await renderComponent(React.createElement(CapsScreen));
		expect(auth.client.listCaps).toHaveBeenCalledTimes(1);

		recordingUploadState.libraryRevision = 1;
		await act(async () => {
			renderer.update(React.createElement(CapsScreen));
			await Promise.resolve();
		});
		expect(auth.client.listCaps).toHaveBeenCalledTimes(2);
		expect(auth.client.getCapStatuses).toHaveBeenCalledTimes(1);
		expect(auth.client.getCapStatuses).toHaveBeenCalledWith(["cap_123"]);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(auth.client.getCapStatuses).toHaveBeenCalledTimes(2);
		expect(auth.client.listCaps).toHaveBeenCalledTimes(3);
		const [capCard] = renderer.root.findAll((node) => {
			const cap = node.props.cap as { id?: string } | undefined;
			return cap?.id === "cap_123";
		});
		expect(capCard?.props.cap.upload).toBeNull();

		await act(async () => {
			renderer.unmount();
		});
		vi.useRealTimers();
	});

	it("renders dashboard folders with native folder rows", async () => {
		const auth = createAuth();
		auth.client.listCaps = () =>
			Promise.resolve({
				caps: [],
				folders: [
					{
						color: "blue",
						id: "folder_123",
						name: "Product",
						parentId: null,
						videoCount: 2,
					},
				],
				pagination: {
					hasNextPage: false,
					page: 1,
					totalPages: 1,
				},
				rootFolders: [],
			});
		authState.value = auth;

		const renderer = await renderComponent(React.createElement(CapsScreen));
		await act(async () => {
			await Promise.resolve();
		});
		const tree = renderer.toJSON();
		const text = getTextNodes(tree);

		expect(text).toContain("Folders");
		expect(text).toContain("Product");
		expect(text.join("")).toContain("2 videos");
		expect(text).not.toContain("Welcome! Record or Import your first Cap");
		expect(text).toContain("No Caps in My Caps");
		expect(text).toContain("Caps added to this space will appear here.");
		expect(hasStyle(tree, { paddingBottom: 24 })).toBe(true);
		expect(hasProp(tree, "accessibilityLabel", "Open folder Product")).toBe(
			true,
		);
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Record" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ accessibilityLabel: "Import Media" }),
		).toHaveLength(1);

		const [folderRow] = renderer.root.findAllByProps({
			accessibilityLabel: "Open folder Product",
		});
		if (!folderRow) throw new Error("Folder row was not rendered");

		expect(resolveStyle(folderRow.props.style)).toMatchObject({
			backgroundColor: "#f0f0f0",
			borderColor: "#e0e0e0",
		});
		expect(resolveStyle(folderRow.props.style, true)).toMatchObject({
			backgroundColor: "#e8e8e8",
			borderColor: "#d9d9d9",
		});

		await act(async () => {
			folderRow.props.onPress();
		});

		expect(
			hasProp(renderer.toJSON(), "accessibilityLabel", "Back to My Caps"),
		).toBe(true);
	});

	it("marks the dashboard card sharing action busy while visibility is updating", async () => {
		const auth = createAuth();
		const cap = {
			commentCount: 2,
			createdAt: "2026-05-18T10:00:00.000Z",
			durationSeconds: 125,
			folderId: null,
			id: "video_123",
			ownerName: "Richie",
			protected: false,
			public: true,
			reactionCount: 3,
			shareUrl: "https://cap.so/s/video_123",
			thumbnailUrl: null,
			title: "Launch review",
			updatedAt: "2026-05-18T10:30:00.000Z",
			upload: null,
			viewCount: 7,
		};
		const sharingDeferred = createDeferred<unknown>();
		auth.client.listCaps = vi.fn(() =>
			Promise.resolve({
				caps: [cap],
				folders: [],
				pagination: {
					hasNextPage: false,
					page: 1,
					totalPages: 1,
				},
				rootFolders: [],
			}),
		);
		auth.client.updateCapSharing = vi.fn(() => sharingDeferred.promise);
		authState.value = auth;

		const renderer = await renderComponent(React.createElement(CapsScreen));
		await act(async () => {
			await Promise.resolve();
		});
		const [capCard] = renderer.root.findAllByProps({ cap });
		if (!capCard) throw new Error("Cap card was not rendered");

		const { ActionSheetIOS } = await import("react-native");
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			capCard.props.onVisibilityPress(cap);
		});

		const [, sharingCallback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!sharingCallback) throw new Error("Sharing callback was not set");

		await act(async () => {
			sharingCallback(0);
			await Promise.resolve();
		});

		const [busyCard] = renderer.root.findAllByProps({ cap });
		if (!busyCard) throw new Error("Busy Cap card was not rendered");

		expect(auth.client.updateCapSharing).toHaveBeenCalledWith("video_123", {
			public: false,
		});
		expect(busyCard.props.visibilityBusy).toBe(true);
		expect(busyCard.props.visibilityDisabled).toBe(true);
		expect(busyCard.props.visibilityDisabledHint).toBe(
			"Sharing update is in progress",
		);
		expect(busyCard.props.visibilityValue).toBeUndefined();
		expect(busyCard.props.visibilityAccessibilityValue).toBe(
			"Updating sharing for Launch review",
		);

		await act(async () => {
			sharingDeferred.resolve({ ...cap, public: false });
			await sharingDeferred.promise;
			await Promise.resolve();
		});
	});

	it("keeps Caps owned by another space member read-only", async () => {
		const auth = createAuth();
		const cap = {
			commentCount: 2,
			createdAt: "2026-05-18T10:00:00.000Z",
			durationSeconds: 125,
			folderId: null,
			id: "video_123",
			ownedByCurrentUser: false,
			ownerName: "Morgan",
			protected: false,
			public: false,
			reactionCount: 3,
			shareUrl: "https://cap.so/s/video_123",
			thumbnailUrl: null,
			title: "Product review",
			updatedAt: "2026-05-18T10:30:00.000Z",
			upload: null,
			viewCount: 0,
		};
		auth.client.listCaps = vi.fn(() =>
			Promise.resolve({
				caps: [cap],
				folders: [],
				pagination: {
					hasNextPage: false,
					page: 1,
					totalPages: 1,
				},
				rootFolders: [],
			}),
		);
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const [capCard] = renderer.root.findAllByProps({ cap });
		if (!capCard) throw new Error("Cap card was not rendered");

		expect(capCard.props.onCopyPress).toEqual(expect.any(Function));
		expect(capCard.props.onSharePress).toEqual(expect.any(Function));
		expect(capCard.props.onAnalyticsPress).toBeUndefined();
		expect(capCard.props.onVisibilityPress).toBeUndefined();
		expect(capCard.props.onMenuPress).toBeUndefined();
	});

	it("opens the native iOS folder creation prompt and color sheet", async () => {
		const auth = createAuth();
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const [newFolder] = renderer.root.findAllByProps({
			accessibilityLabel: "New Folder",
		});
		if (!newFolder) throw new Error("New Folder action was not rendered");

		const { ActionSheetIOS, Alert } = await import("react-native");
		const prompt = vi.mocked(Alert.prompt);
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		prompt.mockClear();
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			newFolder.props.onPress();
		});

		expect(prompt).toHaveBeenCalledWith(
			"New Folder",
			"Name this folder.",
			expect.any(Array),
			"plain-text",
		);

		const buttons = prompt.mock.calls[0]?.[2] as
			| Array<{ onPress?: (value?: string) => void }>
			| undefined;
		if (!Array.isArray(buttons)) {
			throw new Error("Folder prompt buttons were not provided");
		}
		const nextButton = buttons[1];
		const nextAction = nextButton?.onPress;
		if (typeof nextAction !== "function") {
			throw new Error("Folder prompt next action was not provided");
		}

		await act(async () => {
			nextAction("Product");
		});

		expect(showActionSheetWithOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelButtonIndex: 4,
				message: "Product",
				options: ["Normal", "Blue", "Red", "Yellow", "Cancel"],
				title: "Folder color",
				userInterfaceStyle: "light",
			}),
			expect.any(Function),
		);

		const [, colorCallback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!colorCallback) throw new Error("Folder color callback was not set");

		await act(async () => {
			colorCallback(1);
			await Promise.resolve();
		});

		expect(auth.client.createFolder).toHaveBeenCalledWith({
			name: "Product",
			color: "blue",
		});
	});

	it("locks dashboard navigation while a folder is being created", async () => {
		const auth = createAuth();
		const folderDeferred =
			createDeferred<Awaited<ReturnType<AuthStub["client"]["createFolder"]>>>();
		auth.client.createFolder = vi.fn(() => folderDeferred.promise);
		authState.value = auth;
		const renderer = await renderComponent(React.createElement(CapsScreen));
		const [newFolder] = renderer.root.findAllByProps({
			accessibilityLabel: "New Folder",
		});
		if (!newFolder) throw new Error("New Folder action was not rendered");

		const { ActionSheetIOS, Alert } = await import("react-native");
		const prompt = vi.mocked(Alert.prompt);
		const showActionSheetWithOptions = vi.mocked(
			ActionSheetIOS.showActionSheetWithOptions,
		);
		prompt.mockClear();
		showActionSheetWithOptions.mockClear();

		await act(async () => {
			newFolder.props.onPress();
		});

		const buttons = prompt.mock.calls[0]?.[2] as
			| Array<{ onPress?: (value?: string) => void }>
			| undefined;
		const nextAction = buttons?.[1]?.onPress;
		if (typeof nextAction !== "function") {
			throw new Error("Folder prompt next action was not provided");
		}

		await act(async () => {
			nextAction("Product");
		});

		const [, colorCallback] = showActionSheetWithOptions.mock.calls[0] ?? [];
		if (!colorCallback) throw new Error("Folder color callback was not set");

		await act(async () => {
			colorCallback(1);
			await Promise.resolve();
		});

		const [creatingFolder] = renderer.root.findAllByProps({
			accessibilityLabel: "New Folder",
		});
		if (!creatingFolder) {
			throw new Error("Creating folder action was not rendered");
		}
		expect(getTextNodes(renderer.toJSON())).not.toContain("Creating...");
		expect(creatingFolder.props.loading).toBe(true);
		expect(creatingFolder.props.accessibilityHint).toBe(
			"Folder creation is in progress",
		);
		expect(creatingFolder.props.accessibilityValue).toEqual({
			text: "Creating folder Product",
		});
		for (const action of renderer.root.findAllByProps({
			accessibilityLabel: "Import Media",
		})) {
			expect(action.props.disabled).toBe(true);
			expect(action.props.accessibilityHint).toBe(
				"Folder creation is in progress",
			);
			expect(action.props.accessibilityValue).toEqual({
				text: "Creating folder Product",
			});
		}

		await act(async () => {
			folderDeferred.resolve({
				id: "folder_123",
				name: "Product",
				color: "blue",
				parentId: null,
				videoCount: 0,
			});
			await folderDeferred.promise;
			await Promise.resolve();
		});
	});
});
