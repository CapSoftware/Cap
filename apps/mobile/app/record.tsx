import {
	type CameraType,
	useCameraPermissions,
	useMicrophonePermissions,
} from "expo-camera";
import * as Device from "expo-device";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import { TeleprompterOverlay } from "@/recording/TeleprompterOverlay";
import {
	clamp,
	countWords,
	formatRecordingDuration,
	teleprompterDefaults,
	teleprompterLimits,
} from "@/recording/teleprompter";
import { colors, fonts, radius, squircle } from "@/theme";
import { useRecordingUploads } from "@/uploads/recording-upload-provider";
import CapRecorderView, {
	type CapRecorderErrorEvent,
	type CapRecorderSegmentEvent,
} from "../modules/cap-recorder";

type RecorderPhase = "ready" | "starting" | "recording" | "finishing";

const recordingVideoBitrate = 2_500_000;
const recordingSegmentDurationSeconds = 2;
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

export default function RecordScreen() {
	const recordingUploads = useRecordingUploads();
	const insets = useSafeAreaInsets();
	const cameraRef = useRef<CapRecorderView>(null);
	const permissionRequestStarted = useRef(false);
	const discardRecording = useRef(false);
	const activeRecordingId = useRef<string | null>(null);
	const recordingStartedAt = useRef<number | null>(null);
	const [cameraPermission, requestCameraPermission, getCameraPermission] =
		useCameraPermissions();
	const [
		microphonePermission,
		requestMicrophonePermission,
		getMicrophonePermission,
	] = useMicrophonePermissions();
	const [permissionRequestFinished, setPermissionRequestFinished] =
		useState(false);
	const [phase, setPhase] = useState<RecorderPhase>("ready");
	const [cameraReady, setCameraReady] = useState(false);
	const [facing, setFacing] = useState<CameraType>("front");
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
	const cameraActive = permissionsGranted;
	const hasScript = script.trim().length > 0;
	const waitingForPermission =
		!permissionStateLoaded || !permissionRequestFinished;
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
		if (phase !== "recording" || recordingStartedAt.current === null) return;
		const updateElapsed = () => {
			if (recordingStartedAt.current === null) return;
			setElapsedSeconds((Date.now() - recordingStartedAt.current) / 1000);
		};
		updateElapsed();
		const interval = setInterval(updateElapsed, 500);
		return () => clearInterval(interval);
	}, [phase]);

	const startRecording = useCallback(async () => {
		if (!cameraRef.current || !cameraReady || phase !== "ready") return;
		discardRecording.current = false;
		setElapsedSeconds(0);
		setError(null);
		setPhase("starting");
		let createdId: string | null = null;
		try {
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
	}, [cameraReady, hasScript, phase, recordingUploads]);

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
			setElapsedSeconds(0);
			setPhase("ready");
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

	const closeRecorder = useCallback(() => {
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
	}, [phase, stopRecording]);

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
			setElapsedSeconds(0);
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

	if (!permissionsGranted) {
		const missingAccess = cameraPermission?.granted
			? "microphone"
			: "camera and microphone";
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
				<View style={styles.permissionContent}>
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
						Cap needs {missingAccess} access to record your video. Your
						teleprompter stays on screen and is not recorded.
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
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<Stack.Screen options={recorderScreenOptions} />
			<StatusBar barStyle="light-content" />
			<CapRecorderView
				active={cameraActive}
				facing={facing}
				onCameraReady={handleCameraReady}
				onRecordingError={handleRecordingError}
				onRecordingSegment={handleRecordingSegment}
				ref={cameraRef}
				style={StyleSheet.absoluteFill}
			/>
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
				<View
					accessibilityLabel={`Recording time ${formatRecordingDuration(elapsedSeconds)}`}
					style={styles.timerPill}
				>
					{phase === "recording" || phase === "finishing" ? (
						<View style={styles.recordingDot} />
					) : null}
					<Text style={styles.timerText}>
						{formatRecordingDuration(elapsedSeconds)}
					</Text>
				</View>
				<View style={styles.topBarSpacer} />
			</View>
			{hasScript ? (
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
				<CircleButton
					accessibilityLabel={
						hasScript ? "Edit teleprompter" : "Add teleprompter"
					}
					disabled={phase !== "ready"}
					onPress={openEditor}
					symbol="text.alignleft"
				/>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={
						phase === "recording" ? "Stop recording" : "Start recording"
					}
					accessibilityState={{
						disabled:
							!cameraReady || phase === "starting" || phase === "finishing",
					}}
					disabled={
						!cameraReady || phase === "starting" || phase === "finishing"
					}
					onPress={() => {
						if (phase === "recording") void stopRecording();
						else void startRecording();
					}}
					style={({ pressed }) => [
						styles.captureButton,
						pressed ? styles.captureButtonPressed : null,
					]}
				>
					{phase === "starting" || phase === "finishing" ? (
						<ActivityIndicator color={colors.white} />
					) : (
						<View
							style={
								phase === "recording" ? styles.captureStop : styles.captureStart
							}
						/>
					)}
				</Pressable>
				<CircleButton
					accessibilityLabel="Switch camera"
					disabled={phase !== "ready"}
					onPress={() => {
						setCameraReady(false);
						setFacing((current) => (current === "front" ? "back" : "front"));
					}}
					symbol="camera.rotate"
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
		paddingHorizontal: 28,
		paddingTop: 24,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		backgroundColor: "rgba(0,0,0,0.12)",
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
	captureButtonPressed: {
		transform: [{ scale: 0.95 }],
	},
	captureStart: {
		width: 62,
		height: 62,
		borderRadius: radius.full,
		backgroundColor: "#ff3b30",
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
		bottom: 146,
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
