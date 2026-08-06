import {
	type CameraType,
	useCameraPermissions,
	useMicrophonePermissions,
} from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	AppState,
	KeyboardAvoidingView,
	Linking,
	Modal,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from "react-native-reanimated";
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import { apiBaseUrl, useAuth } from "@/auth/AuthContext";
import { getProPlan } from "@/billing/pro";
import { TeleprompterOverlay } from "@/recording/TeleprompterOverlay";
import {
	clamp,
	countWords,
	formatRecordingDuration,
	teleprompterDefaults,
	teleprompterLimits,
} from "@/recording/teleprompter";
import { colors, fonts, radius, squircle } from "@/theme";
import { useRecordingUploadActions } from "@/uploads/recording-upload-provider";
import CapRecorderView, {
	type CapRecorderErrorEvent,
	type CapRecorderSegmentEvent,
} from "../modules/cap-recorder";
import {
	type CapScreenRecorderAvailability,
	CapScreenRecorderView,
	cancelScreenRecording,
	getScreenRecordingAvailability,
	getScreenRecordingUpdates,
	prepareScreenRecording,
} from "../modules/cap-screen-recorder";

type RecorderPhase = "ready" | "starting" | "recording" | "finishing";
type RecordingMode = "camera" | "screen";

const recordingVideoBitrate = 2_500_000;
const screenRecordingVideoBitrate = 1_800_000;
const recordingSegmentDurationSeconds = 2;
const freeRecordingDurationSeconds = 5 * 60;
const capturePressSpring = { damping: 18, stiffness: 320, mass: 0.7 } as const;
const recordingMonthNames = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

const createRecordingFileName = (recordedAt: Date) => {
	const month = recordingMonthNames[recordedAt.getMonth()];
	const hours = String(recordedAt.getHours()).padStart(2, "0");
	const minutes = String(recordedAt.getMinutes()).padStart(2, "0");
	return `Cap Recording - ${recordedAt.getDate()} ${month} ${recordedAt.getFullYear()} at ${hours}.${minutes}.mp4`;
};

const screenModeContent = (
	phase: RecorderPhase,
	availability: CapScreenRecorderAvailability | null,
	prepared: boolean,
) => {
	if (availability?.available === false) {
		return {
			title: "Screen recording unavailable",
			text:
				availability.reason ??
				"Screen recording is unavailable on this iPhone.",
		};
	}
	if (phase === "recording") {
		return {
			title: "Recording your screen",
			text: "Cap is returning Home. Stop from the red screen-sharing indicator or Control Center.",
		};
	}
	if (phase === "finishing") {
		return {
			title: "Finishing up",
			text: "Your recording will upload from Home.",
		};
	}
	if (phase === "starting") {
		return {
			title: "Getting your recording ready",
			text: "Cap is preparing a smooth, upload-ready screen recording.",
		};
	}
	if (prepared) {
		return {
			title: "Ready to record",
			text: "Tap record, then confirm Start Broadcast. Cap returns Home as soon as recording begins.",
		};
	}
	return {
		title: "Record your screen",
		text: "Cap records your screen and microphone, then uploads automatically when you stop.",
	};
};

type ModeSwitcherProps = {
	disabled: boolean;
	mode: RecordingMode;
	onChange: (mode: RecordingMode) => void;
};

function ModeSwitcher({ disabled, mode, onChange }: ModeSwitcherProps) {
	const selection = useSharedValue(mode === "camera" ? 0 : 1);

	useEffect(() => {
		selection.value = withSpring(mode === "camera" ? 0 : 1, {
			damping: 20,
			stiffness: 260,
			mass: 0.75,
		});
	}, [mode, selection]);

	const indicatorStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: selection.value * 112 }],
	}));

	return (
		<View
			accessibilityRole="tablist"
			style={[
				styles.modeSwitcher,
				disabled ? styles.modeSwitcherDisabled : null,
			]}
		>
			<Animated.View style={[styles.modeIndicator, indicatorStyle]} />
			<Pressable
				accessibilityRole="tab"
				accessibilityLabel="Camera recording"
				accessibilityState={{ disabled, selected: mode === "camera" }}
				disabled={disabled}
				onPress={() => onChange("camera")}
				style={styles.modeOption}
			>
				<SymbolView
					name="camera.fill"
					size={15}
					tintColor={
						mode === "camera" ? colors.gray12 : "rgba(255,255,255,0.58)"
					}
					weight="semibold"
				/>
				<Text
					style={[
						styles.modeLabel,
						mode === "camera" ? styles.modeLabelSelected : null,
					]}
				>
					Camera
				</Text>
			</Pressable>
			<Pressable
				accessibilityRole="tab"
				accessibilityLabel="Screen recording"
				accessibilityState={{ disabled, selected: mode === "screen" }}
				disabled={disabled}
				onPress={() => onChange("screen")}
				style={styles.modeOption}
			>
				<SymbolView
					name="rectangle.on.rectangle"
					size={15}
					tintColor={
						mode === "screen" ? colors.gray12 : "rgba(255,255,255,0.58)"
					}
					weight="semibold"
				/>
				<Text
					style={[
						styles.modeLabel,
						mode === "screen" ? styles.modeLabelSelected : null,
					]}
				>
					Screen
				</Text>
			</Pressable>
		</View>
	);
}

type CircleButtonProps = {
	accessibilityLabel: string;
	disabled?: boolean;
	onPress: () => void;
	symbol: "camera.rotate" | "text.alignleft" | "xmark";
};

function CircleButton({
	accessibilityLabel,
	disabled = false,
	onPress,
	symbol,
}: CircleButtonProps) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			accessibilityState={{ disabled }}
			disabled={disabled}
			hitSlop={8}
			onPress={onPress}
			style={({ pressed }) => [
				styles.circleButton,
				pressed ? styles.circleButtonPressed : null,
				disabled ? styles.circleButtonDisabled : null,
			]}
		>
			<SymbolView
				name={symbol}
				size={18}
				tintColor={colors.white}
				weight="semibold"
			/>
		</Pressable>
	);
}

type StepperRowProps = {
	label: string;
	value: string;
	onDecrease: () => void;
	onIncrease: () => void;
	decreaseDisabled: boolean;
	increaseDisabled: boolean;
};

function StepperRow({
	label,
	value,
	onDecrease,
	onIncrease,
	decreaseDisabled,
	increaseDisabled,
}: StepperRowProps) {
	return (
		<View style={styles.stepperRow}>
			<View style={styles.stepperCopy}>
				<Text style={styles.stepperLabel}>{label}</Text>
				<Text style={styles.stepperValue}>{value}</Text>
			</View>
			<View style={styles.stepperControls}>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Decrease ${label.toLowerCase()}`}
					accessibilityState={{ disabled: decreaseDisabled }}
					disabled={decreaseDisabled}
					onPress={onDecrease}
					style={({ pressed }) => [
						styles.stepperButton,
						pressed ? styles.stepperButtonPressed : null,
						decreaseDisabled ? styles.stepperButtonDisabled : null,
					]}
				>
					<SymbolView
						name="minus"
						size={15}
						tintColor={colors.gray12}
						weight="semibold"
					/>
				</Pressable>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Increase ${label.toLowerCase()}`}
					accessibilityState={{ disabled: increaseDisabled }}
					disabled={increaseDisabled}
					onPress={onIncrease}
					style={({ pressed }) => [
						styles.stepperButton,
						pressed ? styles.stepperButtonPressed : null,
						increaseDisabled ? styles.stepperButtonDisabled : null,
					]}
				>
					<SymbolView
						name="plus"
						size={15}
						tintColor={colors.gray12}
						weight="semibold"
					/>
				</Pressable>
			</View>
		</View>
	);
}

type RecorderTimerPillProps = {
	phase: RecorderPhase;
	startedAt: RefObject<number | null>;
	durationLimitSeconds: number | null;
};

function RecorderTimerPill({
	phase,
	startedAt,
	durationLimitSeconds,
}: RecorderTimerPillProps) {
	const [elapsedSeconds, setElapsedSeconds] = useState(0);

	useEffect(() => {
		if (phase === "ready") {
			setElapsedSeconds(0);
			return;
		}
		if (phase !== "recording") return;
		const updateElapsed = () => {
			if (startedAt.current === null) return;
			setElapsedSeconds((Date.now() - startedAt.current) / 1000);
		};
		updateElapsed();
		const interval = setInterval(updateElapsed, 500);
		return () => clearInterval(interval);
	}, [phase, startedAt]);

	return (
		<View
			accessibilityLabel={
				durationLimitSeconds === null
					? `Recording time ${formatRecordingDuration(elapsedSeconds)}`
					: `Recording time ${formatRecordingDuration(elapsedSeconds)} of ${formatRecordingDuration(durationLimitSeconds)}`
			}
			style={styles.timerPill}
		>
			{phase === "recording" || phase === "finishing" ? (
				<View style={styles.recordingDot} />
			) : null}
			<Text style={styles.timerText}>
				{formatRecordingDuration(elapsedSeconds)}
				{durationLimitSeconds === null
					? ""
					: ` / ${formatRecordingDuration(durationLimitSeconds)}`}
			</Text>
		</View>
	);
}

export default function RecordScreen() {
	const auth = useAuth();
	const recordingUploads = useRecordingUploadActions();
	const insets = useSafeAreaInsets();
	const captureScale = useSharedValue(1);
	const captureAnimatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: captureScale.value }],
	}));
	const cameraRef = useRef<CapRecorderView>(null);
	const permissionRequestStarted = useRef(false);
	const discardRecording = useRef(false);
	const activeRecordingId = useRef<string | null>(null);
	const recordingStartedAt = useRef<number | null>(null);
	const automaticStopStarted = useRef(false);
	const screenCompletionStarted = useRef(false);
	const screenPreparationAttempted = useRef(false);
	const screenUpdateInFlight = useRef(false);
	const [cameraPermission, requestCameraPermission, getCameraPermission] =
		useCameraPermissions();
	const [
		microphonePermission,
		requestMicrophonePermission,
		getMicrophonePermission,
	] = useMicrophonePermissions();
	const [permissionRequestFinished, setPermissionRequestFinished] =
		useState(false);
	const [mode, setMode] = useState<RecordingMode>("camera");
	const [phase, setPhase] = useState<RecorderPhase>("ready");
	const [screenAvailability, setScreenAvailability] =
		useState<CapScreenRecorderAvailability | null>(null);
	const [screenPrepared, setScreenPrepared] = useState(false);
	const [recordingDurationLimit, setRecordingDurationLimit] = useState<
		number | null
	>(freeRecordingDurationSeconds);
	const [cameraReady, setCameraReady] = useState(false);
	const [facing, setFacing] = useState<CameraType>("front");
	const [error, setError] = useState<string | null>(null);
	const [script, setScript] = useState("");
	const [fontSize, setFontSize] = useState<number>(
		teleprompterDefaults.fontSize,
	);
	const [wordsPerMinute, setWordsPerMinute] = useState<number>(
		teleprompterDefaults.wordsPerMinute,
	);
	const [teleprompterPlaying, setTeleprompterPlaying] = useState(false);
	const [teleprompterRestartKey, setTeleprompterRestartKey] = useState(0);
	const [editorVisible, setEditorVisible] = useState(false);
	const [draftScript, setDraftScript] = useState("");
	const [draftFontSize, setDraftFontSize] = useState(fontSize);
	const [draftWordsPerMinute, setDraftWordsPerMinute] =
		useState(wordsPerMinute);

	const permissionsGranted =
		cameraPermission?.granted === true &&
		microphonePermission?.granted === true;
	const isPhysicalDevice = Device.isDevice;
	const permissionStateLoaded =
		cameraPermission !== null && microphonePermission !== null;
	const cameraActive = mode === "camera" && permissionsGranted;
	const hasScript = script.trim().length > 0;
	const waitingForPermission =
		!permissionStateLoaded || !permissionRequestFinished;
	const loadRecordingDurationLimit = useCallback(async () => {
		if (!auth.apiKey) {
			setRecordingDurationLimit(freeRecordingDurationSeconds);
			return freeRecordingDurationSeconds;
		}
		try {
			const plan = await getProPlan({
				apiKey: auth.apiKey,
				baseUrl: apiBaseUrl,
			});
			const limit = plan.upgraded ? null : freeRecordingDurationSeconds;
			setRecordingDurationLimit(limit);
			return limit;
		} catch {
			setRecordingDurationLimit(freeRecordingDurationSeconds);
			return freeRecordingDurationSeconds;
		}
	}, [auth.apiKey]);
	const requestPermissions = useCallback(async () => {
		setPermissionRequestFinished(false);
		const nextCameraPermission = cameraPermission?.granted
			? cameraPermission
			: await requestCameraPermission();
		if (nextCameraPermission.granted) {
			if (!microphonePermission?.granted) {
				await requestMicrophonePermission();
			}
		}
		setPermissionRequestFinished(true);
	}, [
		cameraPermission,
		microphonePermission,
		requestCameraPermission,
		requestMicrophonePermission,
	]);

	useEffect(() => {
		if (!isPhysicalDevice) return;
		if (!permissionStateLoaded || permissionRequestStarted.current) return;
		permissionRequestStarted.current = true;
		if (permissionsGranted) {
			setPermissionRequestFinished(true);
			return;
		}
		void requestPermissions().catch(() => {
			setPermissionRequestFinished(true);
		});
	}, [
		isPhysicalDevice,
		permissionStateLoaded,
		permissionsGranted,
		requestPermissions,
	]);

	useEffect(() => {
		if (!isPhysicalDevice) return;
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") return;
			void Promise.all([getCameraPermission(), getMicrophonePermission()])
				.catch(() => undefined)
				.finally(() => setPermissionRequestFinished(true));
		});
		return () => subscription.remove();
	}, [getCameraPermission, getMicrophonePermission, isPhysicalDevice]);

	useEffect(() => {
		void loadRecordingDurationLimit();
	}, [loadRecordingDurationLimit]);

	useEffect(() => {
		if (!isPhysicalDevice) {
			setScreenAvailability({
				available: false,
				minimumSystemVersion: "15.1",
				reason: "Screen recording requires a physical iPhone.",
			});
			return;
		}
		void getScreenRecordingAvailability()
			.then(setScreenAvailability)
			.catch(() =>
				setScreenAvailability({
					available: false,
					minimumSystemVersion: "15.1",
					reason: "Screen recording is unavailable in this build.",
				}),
			);
	}, [isPhysicalDevice]);

	const startRecording = useCallback(async () => {
		if (!cameraRef.current || !cameraReady || phase !== "ready") return;
		discardRecording.current = false;
		automaticStopStarted.current = false;
		setError(null);
		setPhase("starting");
		let createdId: string | null = null;
		try {
			await loadRecordingDurationLimit();
			const created = await recordingUploads.beginRecording({
				fileName: createRecordingFileName(new Date()),
				width: 720,
				height: 1280,
				fps: 30,
			});
			createdId = created.id;
			activeRecordingId.current = created.id;
			await cameraRef.current.startRecording({
				recordingId: created.id,
				videoBitrate: recordingVideoBitrate,
				segmentDurationSeconds: recordingSegmentDurationSeconds,
			});
			recordingStartedAt.current = Date.now();
			setPhase("recording");
			void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
			setTeleprompterRestartKey((current) => current + 1);
			setTeleprompterPlaying(hasScript);
		} catch (recordingError) {
			if (createdId) {
				await recordingUploads.discardRecording(createdId);
			}
			activeRecordingId.current = null;
			recordingStartedAt.current = null;
			setTeleprompterPlaying(false);
			setError(
				recordingError instanceof Error
					? recordingError.message
					: "Cap could not start the camera recording.",
			);
			setPhase("ready");
		}
	}, [
		cameraReady,
		hasScript,
		loadRecordingDurationLimit,
		phase,
		recordingUploads,
	]);

	const prepareScreenCapture = useCallback(async () => {
		if (
			mode !== "screen" ||
			phase !== "ready" ||
			screenPrepared ||
			screenPreparationAttempted.current ||
			!auth.apiKey ||
			screenAvailability?.available !== true
		) {
			return;
		}
		screenPreparationAttempted.current = true;
		setError(null);
		setPhase("starting");
		screenCompletionStarted.current = false;
		let createdId: string | null = null;
		try {
			const durationLimit = await loadRecordingDurationLimit();
			const created = await recordingUploads.beginRecording({
				fileName: createRecordingFileName(new Date()),
				width: 720,
				height: 1280,
				fps: 30,
				uploadOwner: "external",
			});
			createdId = created.id;
			activeRecordingId.current = created.id;
			await prepareScreenRecording({
				recordingId: created.id,
				width: 720,
				height: 1280,
				videoBitrate: screenRecordingVideoBitrate,
				segmentDurationSeconds: recordingSegmentDurationSeconds,
				maximumDurationSeconds: durationLimit,
			});
			setScreenPrepared(true);
			setPhase("ready");
		} catch (recordingError) {
			if (createdId) {
				await cancelScreenRecording(createdId).catch(() => undefined);
				await recordingUploads.discardRecording(createdId);
			}
			activeRecordingId.current = null;
			setScreenPrepared(false);
			setPhase("ready");
			setError(
				recordingError instanceof Error
					? recordingError.message
					: "Cap could not start the screen recording.",
			);
		}
	}, [
		auth.apiKey,
		loadRecordingDurationLimit,
		mode,
		phase,
		recordingUploads,
		screenAvailability?.available,
		screenPrepared,
	]);

	const finishScreenCaptureUI = useCallback(() => {
		activeRecordingId.current = null;
		recordingStartedAt.current = null;
		setScreenPrepared(false);
		setPhase("ready");
		router.dismissAll();
		router.replace("/(tabs)");
	}, []);

	const reconcileScreenCapture = useCallback(async () => {
		const id = activeRecordingId.current;
		if (
			!id ||
			screenUpdateInFlight.current ||
			screenCompletionStarted.current
		) {
			return;
		}
		screenUpdateInFlight.current = true;
		try {
			const updates = await getScreenRecordingUpdates(id);
			if (updates.status === "prepared") {
				setScreenPrepared(true);
				return;
			}
			if (updates.status === "recording") {
				if (recordingStartedAt.current === null) {
					recordingStartedAt.current = Date.now();
				}
				screenCompletionStarted.current = true;
				void Haptics.notificationAsync(
					Haptics.NotificationFeedbackType.Success,
				);
				finishScreenCaptureUI();
				return;
			}
			if (updates.status === "uploading") {
				screenCompletionStarted.current = true;
				finishScreenCaptureUI();
				return;
			}
			if (updates.status === "uploaded") {
				screenCompletionStarted.current = true;
				finishScreenCaptureUI();
				return;
			}
			if (updates.status === "finished") {
				screenCompletionStarted.current = true;
				for (const segment of updates.segments) {
					recordingUploads.addSegment(id, segment);
				}
				recordingUploads.finishRecording(id, {
					durationSeconds: updates.durationSeconds ?? 0.1,
					totalBytes: updates.totalBytes,
				});
				finishScreenCaptureUI();
				return;
			}
			if (updates.status === "cancelled") {
				screenCompletionStarted.current = true;
				await cancelScreenRecording(id).catch(() => undefined);
				await recordingUploads.discardRecording(id);
				activeRecordingId.current = null;
				recordingStartedAt.current = null;
				screenCompletionStarted.current = false;
				screenPreparationAttempted.current = false;
				setScreenPrepared(false);
				setPhase("ready");
				return;
			}
			if (updates.status === "failed" || updates.status === "missing") {
				screenCompletionStarted.current = true;
				await cancelScreenRecording(id).catch(() => undefined);
				await recordingUploads.discardRecording(id);
				activeRecordingId.current = null;
				recordingStartedAt.current = null;
				screenCompletionStarted.current = false;
				setScreenPrepared(false);
				setPhase("ready");
				setError(
					updates.error ??
						(updates.status === "missing"
							? "The screen recording could not be recovered."
							: "The screen recording stopped unexpectedly."),
				);
			}
		} catch (recordingError) {
			setError(
				recordingError instanceof Error
					? recordingError.message
					: "Cap could not read the screen recording.",
			);
		} finally {
			screenUpdateInFlight.current = false;
		}
	}, [finishScreenCaptureUI, recordingUploads]);

	useEffect(() => {
		if (mode !== "screen" || !screenPrepared || !activeRecordingId.current) {
			return;
		}
		void reconcileScreenCapture();
		const interval = setInterval(() => {
			void reconcileScreenCapture();
		}, 750);
		return () => clearInterval(interval);
	}, [mode, reconcileScreenCapture, screenPrepared]);

	useEffect(() => {
		if (
			mode !== "screen" ||
			phase !== "ready" ||
			screenPrepared ||
			screenAvailability?.available !== true
		) {
			return;
		}
		void prepareScreenCapture();
	}, [
		mode,
		phase,
		prepareScreenCapture,
		screenAvailability?.available,
		screenPrepared,
	]);

	const cancelPreparedScreenCapture = useCallback(async () => {
		const id = activeRecordingId.current;
		if (!id) return true;
		const updates = await getScreenRecordingUpdates(id).catch(() => null);
		if (updates?.status === "recording") {
			finishScreenCaptureUI();
			return false;
		}
		await cancelScreenRecording(id).catch(() => undefined);
		await recordingUploads.discardRecording(id);
		activeRecordingId.current = null;
		recordingStartedAt.current = null;
		screenCompletionStarted.current = false;
		screenPreparationAttempted.current = false;
		setScreenPrepared(false);
		setPhase("ready");
		return true;
	}, [finishScreenCaptureUI, recordingUploads]);

	const changeMode = useCallback(
		async (nextMode: RecordingMode) => {
			if (nextMode === mode || phase !== "ready") return;
			if (mode === "screen" && activeRecordingId.current) {
				const cancelled = await cancelPreparedScreenCapture();
				if (!cancelled) return;
			}
			setError(null);
			setCameraReady(false);
			screenPreparationAttempted.current = false;
			setMode(nextMode);
			void Haptics.selectionAsync();
		},
		[cancelPreparedScreenCapture, mode, phase],
	);

	const stopRecording = useCallback(async () => {
		if (phase !== "recording") return;
		setPhase("finishing");
		setTeleprompterPlaying(false);
		const id = activeRecordingId.current;
		try {
			const result = await cameraRef.current?.stopRecording();
			if (!id || !result)
				throw new Error("The camera did not finish recording.");
			if (discardRecording.current) {
				await recordingUploads.discardRecording(id);
				activeRecordingId.current = null;
				recordingStartedAt.current = null;
				router.back();
				return;
			}
			recordingUploads.finishRecording(id, result);
			activeRecordingId.current = null;
			recordingStartedAt.current = null;
			setPhase("ready");
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			router.dismissAll();
			router.replace("/(tabs)");
			return;
		} catch (recordingError) {
			if (id) {
				await recordingUploads.discardRecording(id);
			}
			activeRecordingId.current = null;
			recordingStartedAt.current = null;
			setError(
				recordingError instanceof Error
					? recordingError.message
					: "The camera stopped unexpectedly.",
			);
			setPhase("ready");
		}
	}, [phase, recordingUploads]);

	useEffect(() => {
		if (
			mode !== "camera" ||
			phase !== "recording" ||
			recordingDurationLimit === null
		) {
			return;
		}
		const stopAtLimit = () => {
			if (
				recordingStartedAt.current === null ||
				automaticStopStarted.current ||
				Date.now() - recordingStartedAt.current < recordingDurationLimit * 1000
			) {
				return;
			}
			automaticStopStarted.current = true;
			void stopRecording();
		};
		stopAtLimit();
		const interval = setInterval(stopAtLimit, 250);
		return () => clearInterval(interval);
	}, [mode, phase, recordingDurationLimit, stopRecording]);

	const closeRecorder = useCallback(() => {
		if (mode === "screen") {
			if (phase === "recording") {
				ActionSheetIOS.showActionSheetWithOptions(
					{
						cancelButtonIndex: 0,
						message:
							"Use the red screen-sharing indicator or Control Center to stop. Cap will finish the upload in the background.",
						options: ["Keep recording"],
						title: "Screen recording is active",
						userInterfaceStyle: "dark",
					},
					() => undefined,
				);
				return;
			}
			if (phase === "starting" || phase === "finishing") return;
			if (activeRecordingId.current) {
				void cancelPreparedScreenCapture().then((cancelled) => {
					if (cancelled) router.back();
				});
				return;
			}
			router.back();
			return;
		}
		if (phase === "recording") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: 1,
					destructiveButtonIndex: 0,
					message: "This recording will not be uploaded.",
					options: ["Stop and discard", "Keep recording"],
					title: "Discard recording?",
					userInterfaceStyle: "dark",
				},
				(index) => {
					if (index !== 0) return;
					discardRecording.current = true;
					void stopRecording();
				},
			);
			return;
		}
		if (phase === "starting" || phase === "finishing") return;
		router.back();
	}, [cancelPreparedScreenCapture, mode, phase, stopRecording]);

	const openEditor = useCallback(() => {
		if (phase !== "ready") return;
		setTeleprompterPlaying(false);
		setDraftScript(script);
		setDraftFontSize(fontSize);
		setDraftWordsPerMinute(wordsPerMinute);
		setEditorVisible(true);
	}, [fontSize, phase, script, wordsPerMinute]);

	const applyTeleprompterDraft = useCallback(() => {
		setScript(draftScript);
		setFontSize(draftFontSize);
		setWordsPerMinute(draftWordsPerMinute);
		setTeleprompterRestartKey((current) => current + 1);
		setEditorVisible(false);
	}, [draftFontSize, draftScript, draftWordsPerMinute]);

	const handleCameraReady = useCallback(() => {
		setCameraReady(true);
	}, []);
	const handleRecordingSegment = useCallback(
		({ nativeEvent }: { nativeEvent: CapRecorderSegmentEvent }) => {
			const id = activeRecordingId.current;
			if (id && !discardRecording.current) {
				recordingUploads.addSegment(id, nativeEvent);
			}
		},
		[recordingUploads],
	);
	const handleRecordingError = useCallback(
		({ nativeEvent }: { nativeEvent: CapRecorderErrorEvent }) => {
			setError(nativeEvent.message);
			const id = activeRecordingId.current;
			if (!id) {
				setCameraReady(false);
				return;
			}
			activeRecordingId.current = null;
			recordingStartedAt.current = null;
			setTeleprompterPlaying(false);
			setPhase("ready");
			void recordingUploads.discardRecording(id);
		},
		[recordingUploads],
	);

	if (!isPhysicalDevice) {
		return (
			<View style={styles.permissionScreen}>
				<Stack.Screen options={recorderScreenOptions} />
				<StatusBar barStyle="light-content" />
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Close recorder"
					onPress={() => router.back()}
					style={[styles.permissionClose, { top: insets.top + 8 }]}
				>
					<SymbolView
						name="xmark"
						size={18}
						tintColor={colors.white}
						weight="semibold"
					/>
				</Pressable>
				<View
					accessibilityLabel="Camera unavailable in Simulator"
					style={styles.permissionContent}
				>
					<View style={styles.permissionIcon}>
						<SymbolView
							name="video.fill"
							size={32}
							tintColor={colors.white}
							weight="medium"
						/>
					</View>
					<Text style={styles.permissionTitle}>Use a physical iPhone</Text>
					<Text style={styles.permissionText}>
						Camera and microphone recording is unavailable in iOS Simulator. Run
						Cap on an iPhone to preview and record video.
					</Text>
				</View>
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<Stack.Screen options={recorderScreenOptions} />
			<StatusBar barStyle="light-content" />
			{mode === "camera" && permissionsGranted ? (
				<CapRecorderView
					active={cameraActive}
					facing={facing}
					onCameraReady={handleCameraReady}
					onRecordingError={handleRecordingError}
					onRecordingSegment={handleRecordingSegment}
					ref={cameraRef}
					style={StyleSheet.absoluteFill}
				/>
			) : null}
			{mode === "camera" && !permissionsGranted ? (
				<View style={styles.inlinePermissionContent}>
					<View style={styles.permissionIcon}>
						<SymbolView
							name="video.fill"
							size={32}
							tintColor={colors.white}
							weight="medium"
						/>
					</View>
					<Text style={styles.permissionTitle}>Camera and microphone</Text>
					<Text style={styles.permissionText}>
						Cap needs camera and microphone access for camera recordings. You
						can still switch to Screen below.
					</Text>
					{waitingForPermission ? (
						<ActivityIndicator color={colors.white} />
					) : (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Open Settings"
							onPress={() => void Linking.openSettings()}
							style={({ pressed }) => [
								styles.permissionButton,
								pressed ? styles.permissionButtonPressed : null,
							]}
						>
							<Text style={styles.permissionButtonText}>Open Settings</Text>
						</Pressable>
					)}
				</View>
			) : null}
			{mode === "screen" ? (
				<View style={styles.screenCanvas}>
					<View style={styles.permissionIcon}>
						<SymbolView
							name={
								phase === "recording"
									? "record.circle.fill"
									: "rectangle.on.rectangle"
							}
							size={32}
							tintColor={phase === "recording" ? "#ff453a" : colors.white}
							weight="medium"
						/>
					</View>
					<Text style={styles.permissionTitle}>
						{screenModeContent(phase, screenAvailability, screenPrepared).title}
					</Text>
					<Text style={styles.permissionText}>
						{screenModeContent(phase, screenAvailability, screenPrepared).text}
					</Text>
				</View>
			) : null}
			<View
				pointerEvents="box-none"
				style={[styles.topBar, { paddingTop: insets.top + 8 }]}
			>
				<CircleButton
					accessibilityLabel="Close recorder"
					disabled={phase === "starting" || phase === "finishing"}
					onPress={closeRecorder}
					symbol="xmark"
				/>
				<RecorderTimerPill
					durationLimitSeconds={recordingDurationLimit}
					phase={phase}
					startedAt={recordingStartedAt}
				/>
				<View style={styles.topBarSpacer} />
			</View>
			{mode === "camera" && hasScript && permissionsGranted ? (
				<TeleprompterOverlay
					fontSize={fontSize}
					onTogglePlayback={() => setTeleprompterPlaying((current) => !current)}
					playing={teleprompterPlaying}
					restartKey={teleprompterRestartKey}
					script={script}
					wordsPerMinute={wordsPerMinute}
				/>
			) : null}
			{error ? (
				<View accessibilityRole="alert" style={styles.errorPill}>
					<Text style={styles.errorText}>{error}</Text>
				</View>
			) : null}
			<View
				pointerEvents="box-none"
				style={[styles.bottomControls, { paddingBottom: insets.bottom + 18 }]}
			>
				<View style={styles.captureRow}>
					{mode === "camera" ? (
						<CircleButton
							accessibilityLabel={
								hasScript ? "Edit teleprompter" : "Add teleprompter"
							}
							disabled={phase !== "ready" || !permissionsGranted}
							onPress={openEditor}
							symbol="text.alignleft"
						/>
					) : (
						<View style={styles.topBarSpacer} />
					)}
					{mode === "camera" ? (
						<Animated.View style={captureAnimatedStyle}>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={
									phase === "recording" ? "Stop recording" : "Start recording"
								}
								accessibilityState={{
									disabled:
										!cameraReady ||
										phase === "starting" ||
										phase === "finishing",
								}}
								disabled={
									!cameraReady || phase === "starting" || phase === "finishing"
								}
								onPressIn={() => {
									void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
									captureScale.value = withSpring(0.92, capturePressSpring);
								}}
								onPressOut={() => {
									captureScale.value = withSpring(1, capturePressSpring);
								}}
								onPress={() => {
									if (phase === "recording") void stopRecording();
									else void startRecording();
								}}
								style={styles.captureButton}
							>
								{phase === "starting" || phase === "finishing" ? (
									<ActivityIndicator color={colors.white} />
								) : (
									<View
										style={
											phase === "recording"
												? styles.captureStop
												: styles.captureStart
										}
									/>
								)}
							</Pressable>
						</Animated.View>
					) : (
						<Animated.View style={captureAnimatedStyle}>
							{screenPrepared ? (
								<View style={styles.captureButton}>
									<CapScreenRecorderView
										enabled
										style={styles.screenSystemPicker}
									/>
									<View
										pointerEvents="none"
										style={[styles.captureStart, styles.screenCaptureGlyph]}
									/>
								</View>
							) : (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={
										screenPreparationAttempted.current
											? "Retry screen recording setup"
											: "Prepare screen recording"
									}
									accessibilityState={{
										disabled:
											phase !== "ready" ||
											!auth.apiKey ||
											screenAvailability?.available !== true,
									}}
									disabled={
										phase !== "ready" ||
										!auth.apiKey ||
										screenAvailability?.available !== true
									}
									onPress={() => {
										screenPreparationAttempted.current = false;
										void prepareScreenCapture();
									}}
									style={styles.captureButton}
								>
									{phase !== "ready" ? (
										<ActivityIndicator color={colors.white} />
									) : (
										<View style={styles.captureStart} />
									)}
								</Pressable>
							)}
						</Animated.View>
					)}
					{mode === "camera" ? (
						<CircleButton
							accessibilityLabel="Switch camera"
							disabled={phase !== "ready" || !permissionsGranted}
							onPress={() => {
								setCameraReady(false);
								setFacing((current) =>
									current === "front" ? "back" : "front",
								);
							}}
							symbol="camera.rotate"
						/>
					) : (
						<View style={styles.topBarSpacer} />
					)}
				</View>
				<ModeSwitcher
					disabled={phase !== "ready"}
					mode={mode}
					onChange={(nextMode) => void changeMode(nextMode)}
				/>
			</View>
			<Modal
				allowSwipeDismissal
				animationType="slide"
				onRequestClose={() => setEditorVisible(false)}
				presentationStyle="formSheet"
				visible={editorVisible}
			>
				<SafeAreaView style={styles.editorSafeArea}>
					<KeyboardAvoidingView
						behavior="padding"
						style={styles.editorKeyboard}
					>
						<View style={styles.editorHeader}>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Cancel"
								onPress={() => setEditorVisible(false)}
								style={styles.editorHeaderButton}
							>
								<Text style={styles.editorCancel}>Cancel</Text>
							</Pressable>
							<Text style={styles.editorTitle}>Teleprompter</Text>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Done"
								onPress={applyTeleprompterDraft}
								style={styles.editorHeaderButton}
							>
								<Text style={styles.editorDone}>Done</Text>
							</Pressable>
						</View>
						<ScrollView
							contentContainerStyle={styles.editorContent}
							keyboardShouldPersistTaps="handled"
						>
							<TextInput
								autoFocus
								multiline
								onChangeText={setDraftScript}
								placeholder="Paste or type your script…"
								placeholderTextColor={colors.gray9}
								selectionColor={colors.blue9}
								spellCheck
								style={styles.scriptInput}
								value={draftScript}
							/>
							<Text style={styles.wordCount}>
								{countWords(draftScript)} words · The overlay is not recorded
							</Text>
							<View style={styles.settingsGroup}>
								<StepperRow
									decreaseDisabled={
										draftWordsPerMinute <=
										teleprompterLimits.wordsPerMinute.minimum
									}
									increaseDisabled={
										draftWordsPerMinute >=
										teleprompterLimits.wordsPerMinute.maximum
									}
									label="Scroll speed"
									onDecrease={() =>
										setDraftWordsPerMinute((current) =>
											clamp(
												current - teleprompterLimits.wordsPerMinute.step,
												teleprompterLimits.wordsPerMinute.minimum,
												teleprompterLimits.wordsPerMinute.maximum,
											),
										)
									}
									onIncrease={() =>
										setDraftWordsPerMinute((current) =>
											clamp(
												current + teleprompterLimits.wordsPerMinute.step,
												teleprompterLimits.wordsPerMinute.minimum,
												teleprompterLimits.wordsPerMinute.maximum,
											),
										)
									}
									value={`${draftWordsPerMinute} WPM`}
								/>
								<View style={styles.settingsDivider} />
								<StepperRow
									decreaseDisabled={
										draftFontSize <= teleprompterLimits.fontSize.minimum
									}
									increaseDisabled={
										draftFontSize >= teleprompterLimits.fontSize.maximum
									}
									label="Text size"
									onDecrease={() =>
										setDraftFontSize((current) =>
											clamp(
												current - teleprompterLimits.fontSize.step,
												teleprompterLimits.fontSize.minimum,
												teleprompterLimits.fontSize.maximum,
											),
										)
									}
									onIncrease={() =>
										setDraftFontSize((current) =>
											clamp(
												current + teleprompterLimits.fontSize.step,
												teleprompterLimits.fontSize.minimum,
												teleprompterLimits.fontSize.maximum,
											),
										)
									}
									value={`${draftFontSize} pt`}
								/>
							</View>
						</ScrollView>
					</KeyboardAvoidingView>
				</SafeAreaView>
			</Modal>
		</View>
	);
}

const styles = StyleSheet.create({
	stackContent: {
		backgroundColor: colors.black,
	},
	screen: {
		flex: 1,
		backgroundColor: colors.black,
	},
	topBar: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		zIndex: 5,
		paddingHorizontal: 16,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	topBarSpacer: {
		width: 46,
		height: 46,
	},
	circleButton: {
		width: 46,
		height: 46,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(8,10,14,0.48)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.2)",
	},
	circleButtonPressed: {
		backgroundColor: "rgba(8,10,14,0.66)",
		transform: [{ scale: 0.96 }],
	},
	circleButtonDisabled: {
		opacity: 0.38,
	},
	timerPill: {
		height: 34,
		minWidth: 82,
		borderRadius: radius.full,
		paddingHorizontal: 13,
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
		gap: 7,
		backgroundColor: "rgba(8,10,14,0.48)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.16)",
	},
	recordingDot: {
		width: 7,
		height: 7,
		borderRadius: radius.full,
		backgroundColor: "#ff453a",
	},
	timerText: {
		fontFamily: fonts.medium,
		fontSize: 14,
		fontVariant: ["tabular-nums"],
		color: colors.white,
	},
	bottomControls: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		zIndex: 5,
		paddingHorizontal: 20,
		paddingTop: 24,
		alignItems: "center",
		gap: 18,
		backgroundColor: "rgba(0,0,0,0.18)",
	},
	captureRow: {
		width: "100%",
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 8,
	},
	modeSwitcher: {
		width: 232,
		height: 48,
		padding: 4,
		borderRadius: radius.full,
		flexDirection: "row",
		backgroundColor: "rgba(12,14,18,0.78)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.18)",
	},
	modeSwitcherDisabled: {
		opacity: 0.58,
	},
	modeIndicator: {
		position: "absolute",
		top: 4,
		left: 4,
		width: 112,
		height: 40,
		borderRadius: radius.full,
		backgroundColor: colors.white,
	},
	modeOption: {
		zIndex: 1,
		width: 112,
		height: 40,
		borderRadius: radius.full,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
	},
	modeLabel: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: "rgba(255,255,255,0.58)",
	},
	modeLabelSelected: {
		color: colors.gray12,
	},
	captureButton: {
		width: 82,
		height: 82,
		borderRadius: radius.full,
		borderWidth: 5,
		borderColor: "rgba(255,255,255,0.92)",
		alignItems: "center",
		justifyContent: "center",
	},
	captureStart: {
		width: 62,
		height: 62,
		borderRadius: radius.full,
		backgroundColor: "#ff3b30",
	},
	screenSystemPicker: {
		...StyleSheet.absoluteFillObject,
		zIndex: 1,
	},
	screenCaptureGlyph: {
		zIndex: 2,
	},
	captureStop: {
		width: 31,
		height: 31,
		borderRadius: radius.sm,
		backgroundColor: "#ff3b30",
		...squircle,
	},
	errorPill: {
		position: "absolute",
		zIndex: 6,
		left: 24,
		right: 24,
		bottom: 224,
		borderRadius: radius.md,
		backgroundColor: "rgba(102,15,20,0.86)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.18)",
		paddingHorizontal: 14,
		paddingVertical: 12,
		...squircle,
	},
	errorText: {
		fontFamily: fonts.medium,
		fontSize: 13,
		lineHeight: 18,
		textAlign: "center",
		color: colors.white,
	},
	permissionScreen: {
		flex: 1,
		backgroundColor: "#08090c",
	},
	permissionClose: {
		position: "absolute",
		left: 16,
		zIndex: 2,
		width: 46,
		height: 46,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255,255,255,0.1)",
	},
	permissionContent: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 34,
	},
	inlinePermissionContent: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 34,
		paddingBottom: 174,
		backgroundColor: "#08090c",
	},
	permissionIcon: {
		width: 72,
		height: 72,
		borderRadius: radius.xl,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255,255,255,0.1)",
		...squircle,
	},
	permissionTitle: {
		marginTop: 22,
		fontFamily: fonts.medium,
		fontSize: 26,
		lineHeight: 32,
		color: colors.white,
		textAlign: "center",
	},
	permissionText: {
		marginTop: 10,
		marginBottom: 24,
		fontFamily: fonts.regular,
		fontSize: 16,
		lineHeight: 23,
		color: "rgba(255,255,255,0.66)",
		textAlign: "center",
	},
	permissionButton: {
		height: 50,
		minWidth: 170,
		borderRadius: radius.full,
		paddingHorizontal: 24,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.white,
	},
	permissionButtonPressed: {
		opacity: 0.82,
	},
	permissionButtonText: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	screenCanvas: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 34,
		paddingBottom: 174,
		backgroundColor: "#08090c",
	},
	editorSafeArea: {
		flex: 1,
		backgroundColor: colors.appBackground,
	},
	editorKeyboard: {
		flex: 1,
	},
	editorHeader: {
		height: 56,
		paddingHorizontal: 12,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.gray5,
		backgroundColor: colors.gray1,
	},
	editorHeaderButton: {
		minWidth: 64,
		height: 44,
		justifyContent: "center",
	},
	editorCancel: {
		fontFamily: fonts.regular,
		fontSize: 16,
		color: colors.blue11,
	},
	editorDone: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.blue11,
		textAlign: "right",
	},
	editorTitle: {
		fontFamily: fonts.medium,
		fontSize: 17,
		color: colors.gray12,
	},
	editorContent: {
		padding: 16,
		paddingBottom: 36,
	},
	scriptInput: {
		minHeight: 260,
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		paddingHorizontal: 18,
		paddingVertical: 16,
		fontFamily: fonts.regular,
		fontSize: 20,
		lineHeight: 28,
		color: colors.gray12,
		backgroundColor: colors.white,
		textAlignVertical: "top",
		...squircle,
	},
	wordCount: {
		marginTop: 9,
		marginHorizontal: 4,
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray9,
	},
	settingsGroup: {
		marginTop: 22,
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		backgroundColor: colors.white,
		overflow: "hidden",
		...squircle,
	},
	settingsDivider: {
		height: StyleSheet.hairlineWidth,
		marginLeft: 16,
		backgroundColor: colors.gray5,
	},
	stepperRow: {
		minHeight: 68,
		paddingHorizontal: 16,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 16,
	},
	stepperCopy: {
		flex: 1,
	},
	stepperLabel: {
		fontFamily: fonts.medium,
		fontSize: 15,
		color: colors.gray12,
	},
	stepperValue: {
		marginTop: 2,
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray9,
	},
	stepperControls: {
		flexDirection: "row",
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		overflow: "hidden",
	},
	stepperButton: {
		width: 42,
		height: 34,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray2,
	},
	stepperButtonPressed: {
		backgroundColor: colors.gray4,
	},
	stepperButtonDisabled: {
		opacity: 0.32,
	},
});

const recorderScreenOptions = {
	animation: "fade" as const,
	contentStyle: styles.stackContent,
	gestureEnabled: false,
	presentation: "fullScreenModal" as const,
};
