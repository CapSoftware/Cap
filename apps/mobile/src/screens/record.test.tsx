import React, { type ReactElement, type ReactNode } from "react";
import { Linking, TextInput } from "react-native";
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeleprompterOverlay } from "@/recording/TeleprompterOverlay";
import RecordScreen from "../../app/record";
import CapRecorderView from "../../modules/cap-recorder";
import { CapScreenRecorderView } from "../../modules/cap-screen-recorder";

type HostProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

const cameraState = vi.hoisted(() => ({
	startRecording: vi.fn(() => Promise.resolve()),
	stopRecording: vi.fn(),
}));

const screenRecordingState = vi.hoisted(() => ({
	availability: vi.fn(() =>
		Promise.resolve({
			available: true,
			minimumSystemVersion: "15.1",
			reason: null as string | null,
		}),
	),
	cancelRecording: vi.fn(() => Promise.resolve()),
	getUpdates: vi.fn(),
	prepareRecording: vi.fn(() => Promise.resolve()),
}));

const permissionState = vi.hoisted(() => ({
	cameraGranted: true,
	microphoneGranted: true,
	getCamera: vi.fn(),
	getMicrophone: vi.fn(),
	requestCamera: vi.fn(),
	requestMicrophone: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
	back: vi.fn(),
	dismissAll: vi.fn(),
	replace: vi.fn(),
}));

const stackState = vi.hoisted(() => ({
	options: [] as unknown[],
}));

const deviceState = vi.hoisted(() => ({
	isDevice: true,
}));

const authState = vi.hoisted(() => ({
	apiKey: "mobile-key" as string | null,
}));

const billingState = vi.hoisted(() => ({
	getProPlan: vi.fn(() =>
		Promise.resolve({
			upgraded: false,
			stripeSubscriptionStatus: null as string | null,
		}),
	),
}));

const uploadState = vi.hoisted(() => ({
	beginRecording: vi.fn(() =>
		Promise.resolve({ id: "cap_123", shareUrl: "https://cap.so/s/cap_123" }),
	),
	addSegment: vi.fn(),
	finishRecording: vi.fn(),
	discardRecording: vi.fn(() => Promise.resolve()),
	failRecording: vi.fn(),
	retryRecording: vi.fn(),
	queue: { jobs: [] },
}));

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
	const React = await import("react");
	const createHost =
		(name: string) =>
		({ children, ...props }: HostProps) =>
			React.createElement(name, props, children);

	return {
		ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
		ActivityIndicator: createHost("ActivityIndicator"),
		AppState: {
			addEventListener: vi.fn(() => ({ remove: vi.fn() })),
		},
		KeyboardAvoidingView: createHost("KeyboardAvoidingView"),
		Linking: { openSettings: vi.fn(() => Promise.resolve()) },
		Modal: createHost("Modal"),
		Pressable: createHost("Pressable"),
		ScrollView: createHost("ScrollView"),
		StatusBar: createHost("StatusBar"),
		StyleSheet: {
			absoluteFill: {},
			absoluteFillObject: {},
			create: <T extends Record<string, unknown>>(styles: T) => styles,
			hairlineWidth: 1,
		},
		Text: createHost("Text"),
		TextInput: createHost("TextInput"),
		View: createHost("View"),
	};
});

vi.mock("react-native-safe-area-context", async () => {
	const React = await import("react");
	return {
		SafeAreaView: ({ children, ...props }: HostProps) =>
			React.createElement("SafeAreaView", props, children),
		useSafeAreaInsets: () => ({ bottom: 24, left: 0, right: 0, top: 48 }),
	};
});

vi.mock("expo-camera", async () => {
	const permission = {
		canAskAgain: true,
		expires: "never",
		granted: true,
		status: "granted",
	};
	const permissionResponse = (granted: boolean) => ({
		...permission,
		granted,
		status: granted ? "granted" : "denied",
	});
	return {
		useCameraPermissions: () => [
			permissionResponse(permissionState.cameraGranted),
			permissionState.requestCamera,
			permissionState.getCamera,
		],
		useMicrophonePermissions: () => [
			permissionResponse(permissionState.microphoneGranted),
			permissionState.requestMicrophone,
			permissionState.getMicrophone,
		],
	};
});

vi.mock("../../modules/cap-recorder", async () => {
	const React = await import("react");
	const CapRecorderView = React.forwardRef<unknown, HostProps>((props, ref) => {
		React.useImperativeHandle(ref, () => ({
			startRecording: cameraState.startRecording,
			stopRecording: cameraState.stopRecording,
		}));
		const onCameraReady = props.onCameraReady;
		React.useEffect(() => {
			if (typeof onCameraReady === "function") onCameraReady();
		}, [onCameraReady]);
		return React.createElement("CapRecorderView", props);
	});
	return { default: CapRecorderView };
});

vi.mock("../../modules/cap-screen-recorder", async () => {
	const React = await import("react");
	return {
		CapScreenRecorderView: (props: HostProps) =>
			React.createElement("CapScreenRecorderView", props),
		cancelScreenRecording: screenRecordingState.cancelRecording,
		getScreenRecordingAvailability: screenRecordingState.availability,
		getScreenRecordingUpdates: screenRecordingState.getUpdates,
		prepareScreenRecording: screenRecordingState.prepareRecording,
	};
});

vi.mock("expo-device", () => ({
	get isDevice() {
		return deviceState.isDevice;
	},
}));

vi.mock("expo-haptics", () => ({
	impactAsync: vi.fn(() => Promise.resolve()),
	notificationAsync: vi.fn(() => Promise.resolve()),
	selectionAsync: vi.fn(() => Promise.resolve()),
	ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
	NotificationFeedbackType: { Success: "success" },
}));

vi.mock("react-native-reanimated", async () => {
	const React = await import("react");
	return {
		default: {
			View: ({ children, ...props }: HostProps) =>
				React.createElement("Animated.View", props, children),
		},
		useAnimatedStyle: (factory: () => unknown) => factory(),
		useSharedValue: (value: unknown) => ({ value }),
		withSpring: (value: unknown) => value,
	};
});

vi.mock("expo-router", async () => {
	const React = await import("react");
	return {
		router: routerState,
		Stack: {
			Screen: (props: HostProps) => {
				stackState.options.push(props.options);
				return React.createElement("StackScreen", props);
			},
		},
	};
});

vi.mock("expo-symbols", async () => {
	const React = await import("react");
	return {
		SymbolView: (props: HostProps) => React.createElement("SymbolView", props),
	};
});

vi.mock("@/recording/TeleprompterOverlay", async () => {
	const React = await import("react");
	return {
		TeleprompterOverlay: (props: HostProps) =>
			React.createElement("TeleprompterOverlay", props),
	};
});

vi.mock("@/uploads/recording-upload-provider", () => ({
	useRecordingUploadActions: () => uploadState,
}));

vi.mock("@/auth/AuthContext", () => ({
	apiBaseUrl: "https://cap.so",
	useAuth: () => authState,
}));

vi.mock("@/billing/pro", () => billingState);

const renderComponent = async (
	node: ReactElement,
): Promise<ReactTestRenderer> => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = TestRenderer.create(node);
	});
	return renderer as unknown as ReactTestRenderer;
};

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

const selectAndPrepareScreenRecording = async (renderer: ReactTestRenderer) => {
	await act(async () => {
		await flushMicrotasks();
		renderer.root
			.findByProps({ accessibilityLabel: "Screen recording" })
			.props.onPress();
		await flushMicrotasks();
	});
};

describe("RecordScreen", () => {
	beforeEach(() => {
		authState.apiKey = "mobile-key";
		billingState.getProPlan.mockReset();
		billingState.getProPlan.mockResolvedValue({
			upgraded: false,
			stripeSubscriptionStatus: null,
		});
		cameraState.startRecording.mockReset();
		cameraState.startRecording.mockResolvedValue(undefined);
		cameraState.stopRecording.mockReset();
		cameraState.stopRecording.mockResolvedValue({
			durationSeconds: 4.2,
			segmentCount: 2,
			totalBytes: 1_400_000,
		});
		routerState.back.mockReset();
		routerState.dismissAll.mockReset();
		routerState.replace.mockReset();
		stackState.options.length = 0;
		uploadState.beginRecording.mockReset();
		uploadState.beginRecording.mockResolvedValue({
			id: "cap_123",
			shareUrl: "https://cap.so/s/cap_123",
		});
		uploadState.addSegment.mockReset();
		uploadState.finishRecording.mockReset();
		uploadState.discardRecording.mockReset();
		uploadState.discardRecording.mockResolvedValue(undefined);
		permissionState.cameraGranted = true;
		permissionState.microphoneGranted = true;
		deviceState.isDevice = true;
		const grantedPermission = {
			canAskAgain: true,
			expires: "never",
			granted: true,
			status: "granted",
		};
		permissionState.getCamera.mockReset();
		permissionState.getCamera.mockResolvedValue(grantedPermission);
		permissionState.getMicrophone.mockReset();
		permissionState.getMicrophone.mockResolvedValue(grantedPermission);
		permissionState.requestCamera.mockReset();
		permissionState.requestCamera.mockResolvedValue(grantedPermission);
		permissionState.requestMicrophone.mockReset();
		permissionState.requestMicrophone.mockResolvedValue(grantedPermission);
		screenRecordingState.cancelRecording.mockReset();
		screenRecordingState.cancelRecording.mockResolvedValue(undefined);
		screenRecordingState.availability.mockReset();
		screenRecordingState.availability.mockResolvedValue({
			available: true,
			minimumSystemVersion: "15.1",
			reason: null,
		});
		screenRecordingState.prepareRecording.mockReset();
		screenRecordingState.prepareRecording.mockResolvedValue(undefined);
		screenRecordingState.getUpdates.mockReset();
		screenRecordingState.getUpdates.mockResolvedValue({
			status: "prepared",
			segments: [],
			durationSeconds: null,
			totalBytes: 0,
			error: null,
		});
	});

	it("renders the native segmented iOS camera preview", async () => {
		const renderer = await renderComponent(React.createElement(RecordScreen));
		const camera = renderer.root.findByType(CapRecorderView);

		expect(camera.props).toMatchObject({
			active: true,
			facing: "front",
		});
		expect(
			renderer.root.findByProps({ accessibilityLabel: "Add teleprompter" }),
		).toBeTruthy();
		expect(
			renderer.root.findByProps({
				accessibilityLabel: "Recording time 0:00 of 5:00",
			}),
		).toBeTruthy();
	});

	it("keeps native modal options stable when the camera becomes ready", async () => {
		await renderComponent(React.createElement(RecordScreen));

		expect(stackState.options.length).toBeGreaterThan(1);
		expect(new Set(stackState.options).size).toBe(1);
	});

	it("keeps the native modal mounted while permissions become granted", async () => {
		const grantedPermission = {
			canAskAgain: true,
			expires: "never",
			granted: true,
			status: "granted",
		};
		permissionState.cameraGranted = false;
		permissionState.microphoneGranted = false;
		permissionState.requestCamera.mockImplementationOnce(async () => {
			permissionState.cameraGranted = true;
			return grantedPermission;
		});
		permissionState.requestMicrophone.mockImplementationOnce(async () => {
			permissionState.microphoneGranted = true;
			return grantedPermission;
		});

		const renderer = await renderComponent(React.createElement(RecordScreen));

		expect(permissionState.requestCamera).toHaveBeenCalledTimes(1);
		expect(permissionState.requestMicrophone).toHaveBeenCalledTimes(1);
		expect(renderer.root.findAllByType(CapRecorderView)).toHaveLength(1);
		expect(new Set(stackState.options).size).toBe(1);
	});

	it("does not mount camera capture in iOS Simulator", async () => {
		deviceState.isDevice = false;
		permissionState.cameraGranted = false;
		permissionState.microphoneGranted = false;

		const renderer = await renderComponent(React.createElement(RecordScreen));

		expect(
			renderer.root.findByProps({
				accessibilityLabel: "Camera unavailable in Simulator",
			}),
		).toBeTruthy();
		expect(renderer.root.findAllByType(CapRecorderView)).toHaveLength(0);
		expect(permissionState.requestCamera).not.toHaveBeenCalled();
		expect(permissionState.requestMicrophone).not.toHaveBeenCalled();
	});

	it("offers the native Settings recovery when camera access is denied", async () => {
		permissionState.cameraGranted = false;
		permissionState.requestCamera.mockResolvedValueOnce({
			canAskAgain: false,
			expires: "never",
			granted: false,
			status: "denied",
		});
		const renderer = await renderComponent(React.createElement(RecordScreen));

		expect(permissionState.requestCamera).toHaveBeenCalledTimes(1);
		const settingsButton = renderer.root.findByProps({
			accessibilityLabel: "Open Settings",
		});
		await act(async () => {
			settingsButton.props.onPress();
			await Promise.resolve();
		});
		expect(Linking.openSettings).toHaveBeenCalledTimes(1);
	});

	it("prepares ReplayKit and exposes one native record control", async () => {
		permissionState.cameraGranted = false;
		permissionState.microphoneGranted = false;
		permissionState.requestCamera.mockResolvedValueOnce({
			canAskAgain: false,
			expires: "never",
			granted: false,
			status: "denied",
		});
		const renderer = await renderComponent(React.createElement(RecordScreen));

		await act(async () => {
			await flushMicrotasks();
			renderer.root
				.findByProps({ accessibilityLabel: "Screen recording" })
				.props.onPress();
			await flushMicrotasks();
		});

		expect(renderer.root.findAllByType(CapRecorderView)).toHaveLength(0);
		expect(uploadState.beginRecording).toHaveBeenCalledWith({
			fileName: expect.stringMatching(
				/^Cap Recording - \d{1,2} [A-Z][a-z]{2} \d{4} at \d{2}\.\d{2}\.mp4$/,
			),
			width: 720,
			height: 1280,
			fps: 30,
			uploadOwner: "external",
		});
		expect(screenRecordingState.prepareRecording).toHaveBeenCalledWith({
			recordingId: "cap_123",
			width: 720,
			height: 1280,
			videoBitrate: 1_800_000,
			segmentDurationSeconds: 2,
			maximumDurationSeconds: 300,
		});
		expect(renderer.root.findByType(CapScreenRecorderView)).toBeTruthy();
	});

	it("disables screen capture with a clear system requirement", async () => {
		screenRecordingState.availability.mockResolvedValueOnce({
			available: false,
			minimumSystemVersion: "15.1",
			reason: "Screen recording is unavailable on this iPhone.",
		});
		const renderer = await renderComponent(React.createElement(RecordScreen));

		await act(async () => {
			await flushMicrotasks();
			renderer.root
				.findByProps({ accessibilityLabel: "Screen recording" })
				.props.onPress();
			await flushMicrotasks();
		});

		expect(
			renderer.root.findByProps({
				accessibilityLabel: "Prepare screen recording",
			}).props.accessibilityState,
		).toEqual({ disabled: true });
		expect(uploadState.beginRecording).not.toHaveBeenCalled();
	});

	it("cancels a prepared ReplayKit recording when the recorder closes", async () => {
		const renderer = await renderComponent(React.createElement(RecordScreen));
		await selectAndPrepareScreenRecording(renderer);

		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Close recorder" })
				.props.onPress();
			await flushMicrotasks();
		});

		expect(screenRecordingState.cancelRecording).toHaveBeenCalledWith(
			"cap_123",
		);
		expect(uploadState.discardRecording).toHaveBeenCalledWith("cap_123");
		expect(routerState.back).toHaveBeenCalledTimes(1);
		expect(routerState.replace).not.toHaveBeenCalled();
	});

	it("returns home while the provider reconciles a native screen upload", async () => {
		vi.useFakeTimers();
		try {
			const renderer = await renderComponent(React.createElement(RecordScreen));
			await selectAndPrepareScreenRecording(renderer);
			screenRecordingState.getUpdates.mockResolvedValue({
				status: "uploaded",
				segments: [],
				durationSeconds: 8,
				totalBytes: 1_900_000,
				error: null,
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(750);
				await flushMicrotasks();
			});

			expect(screenRecordingState.cancelRecording).not.toHaveBeenCalled();
			expect(routerState.replace).toHaveBeenCalledWith("/(tabs)");
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns home as soon as the native screen upload starts finishing", async () => {
		vi.useFakeTimers();
		try {
			const renderer = await renderComponent(React.createElement(RecordScreen));
			await selectAndPrepareScreenRecording(renderer);
			screenRecordingState.getUpdates.mockResolvedValue({
				status: "uploading",
				segments: [],
				durationSeconds: 8,
				totalBytes: 1_900_000,
				error: null,
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(750);
				await flushMicrotasks();
			});

			expect(uploadState.addSegment).not.toHaveBeenCalled();
			expect(uploadState.finishRecording).not.toHaveBeenCalled();
			expect(routerState.dismissAll).toHaveBeenCalledTimes(1);
			expect(routerState.replace).toHaveBeenCalledWith("/(tabs)");
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns home once ReplayKit starts recording", async () => {
		vi.useFakeTimers();
		try {
			const renderer = await renderComponent(React.createElement(RecordScreen));
			await selectAndPrepareScreenRecording(renderer);
			screenRecordingState.getUpdates.mockResolvedValue({
				status: "recording",
				segments: [],
				durationSeconds: null,
				totalBytes: 0,
				error: null,
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(750);
				await flushMicrotasks();
			});

			expect(routerState.dismissAll).toHaveBeenCalledTimes(1);
			expect(routerState.replace).toHaveBeenCalledWith("/(tabs)");
		} finally {
			vi.useRealTimers();
		}
	});

	it("streams optimized segments and returns to a ready camera after stop", async () => {
		const renderer = await renderComponent(React.createElement(RecordScreen));

		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Add teleprompter" })
				.props.onPress();
		});
		await act(async () => {
			renderer.root
				.findByType(TextInput)
				.props.onChangeText("This is a short camera script");
		});
		await act(async () => {
			renderer.root.findByProps({ accessibilityLabel: "Done" }).props.onPress();
		});

		expect(renderer.root.findByType(TeleprompterOverlay).props).toMatchObject({
			fontSize: 30,
			script: "This is a short camera script",
			wordsPerMinute: 150,
		});

		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Start recording" })
				.props.onPress();
			await flushMicrotasks();
		});
		expect(uploadState.beginRecording).toHaveBeenCalledWith({
			fileName: expect.stringMatching(
				/^Cap Recording - \d{1,2} [A-Z][a-z]{2} \d{4} at \d{2}\.\d{2}\.mp4$/,
			),
			width: 720,
			height: 1280,
			fps: 30,
		});
		expect(cameraState.startRecording).toHaveBeenCalledWith({
			recordingId: "cap_123",
			videoBitrate: 2_500_000,
			segmentDurationSeconds: 2,
		});
		expect(renderer.root.findByType(TeleprompterOverlay).props.playing).toBe(
			true,
		);

		await act(async () => {
			renderer.root.findByType(CapRecorderView).props.onRecordingSegment({
				nativeEvent: {
					track: "video",
					type: "media",
					index: 1,
					uri: "file:///recording/segment_001.m4s",
					durationSeconds: 2,
					byteLength: 650_000,
				},
			});
		});
		expect(uploadState.addSegment).toHaveBeenCalledWith(
			"cap_123",
			expect.objectContaining({ index: 1, track: "video", type: "media" }),
		);

		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Stop recording" })
				.props.onPress();
		});
		expect(cameraState.stopRecording).toHaveBeenCalledTimes(1);
		expect(uploadState.finishRecording).toHaveBeenCalledWith("cap_123", {
			durationSeconds: 4.2,
			segmentCount: 2,
			totalBytes: 1_400_000,
		});
		expect(routerState.dismissAll).toHaveBeenCalledTimes(1);
		expect(routerState.replace).toHaveBeenCalledWith("/(tabs)");
		expect(routerState.back).not.toHaveBeenCalled();
	});

	it("automatically stops Free plan recordings at five minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T10:00:00.000Z"));
		try {
			const renderer = await renderComponent(React.createElement(RecordScreen));

			await act(async () => {
				renderer.root
					.findByProps({ accessibilityLabel: "Start recording" })
					.props.onPress();
				await flushMicrotasks();
			});
			expect(cameraState.stopRecording).not.toHaveBeenCalled();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(299_999);
			});
			expect(cameraState.stopRecording).not.toHaveBeenCalled();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
				await flushMicrotasks();
			});

			expect(cameraState.stopRecording).toHaveBeenCalledTimes(1);
			expect(uploadState.finishRecording).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows existing Pro recordings as unlimited", async () => {
		billingState.getProPlan.mockResolvedValue({
			upgraded: true,
			stripeSubscriptionStatus: "active",
		});
		const renderer = await renderComponent(React.createElement(RecordScreen));

		await act(async () => {
			await flushMicrotasks();
		});

		expect(
			renderer.root.findByProps({
				accessibilityLabel: "Recording time 0:00",
			}),
		).toBeTruthy();
		expect(
			renderer.root.findAllByProps({
				accessibilityLabel: "Recording time 0:00 of 5:00",
			}),
		).toHaveLength(0);
	});

	it("cleans up a failed native recording without disabling the preview", async () => {
		const renderer = await renderComponent(React.createElement(RecordScreen));

		await act(async () => {
			renderer.root
				.findByProps({ accessibilityLabel: "Start recording" })
				.props.onPress();
			await flushMicrotasks();
		});
		await act(async () => {
			renderer.root.findByType(CapRecorderView).props.onRecordingError({
				nativeEvent: { message: "The camera encoder stopped." },
			});
			await Promise.resolve();
		});

		expect(uploadState.discardRecording).toHaveBeenCalledWith("cap_123");
		expect(
			renderer.root.findByProps({ accessibilityLabel: "Start recording" }),
		).toBeTruthy();
		expect(
			renderer.root.findByProps({ accessibilityRole: "alert" }),
		).toBeTruthy();
	});
});
