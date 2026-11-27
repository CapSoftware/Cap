export type Action =
	| { type: "copyToClipboard"; source?: ClipboardSource }
	| { type: "saveToLocation"; dir: string; filenameTemplate?: string | null }
	| { type: "export"; profile: ExportProfile; destination?: ExportDestination }
	| {
			type: "upload";
			organizationId?: string | null;
			copyLink?: boolean;
			openInBrowser?: boolean;
	  }
	| { type: "revealInFileManager" }
	| { type: "openFile" }
	| {
			type: "runCommand";
			program: string;
			args?: string[];
			cwd?: string | null;
			env?: { [key in string]: string };
			useShell?: boolean;
	  }
	| {
			type: "webhook";
			url: string;
			method?: string;
			headers?: { [key in string]: string };
			bodyTemplate?: string | null;
	  }
	| { type: "recognizeTextToClipboard" }
	| { type: "notify"; titleTemplate?: string; bodyTemplate?: string }
	| { type: "openEditor" }
	| { type: "skipEditor" }
	| { type: "applyPreset"; name: string }
	| { type: "deleteLocalFiles" };
export type AnimatedGradientCatalog = {
	defaultConfig: AnimatedGradientConfig;
	templates: AnimatedGradientPreset[];
	controls: AnimatedGradientControl[];
};
export type AnimatedGradientConfig = {
	colorStops: AnimatedGradientStop[];
	direction: number;
	flowScale: number;
	flowStrength: number;
	curvature: number;
	detail: number;
	relief: number;
	light: number;
	shade: number;
	ripples: number;
	grainAmount: number;
	grainSize: number;
	exposure: number;
	contrast: number;
	vibrance: number;
	motionSpeed: number;
	seed: number;
};
export type AnimatedGradientControl = {
	key: AnimatedGradientParameter;
	label: string;
	group: string;
	min: number;
	max: number;
	step: number;
};
export type AnimatedGradientLibrary = {
	presets: AnimatedGradientPreset[];
	lastUsed: AnimatedGradientConfig | null;
	selected: boolean;
};
export type AnimatedGradientParameter =
	| "direction"
	| "flowScale"
	| "flowStrength"
	| "curvature"
	| "detail"
	| "relief"
	| "light"
	| "shade"
	| "ripples"
	| "grainAmount"
	| "grainSize"
	| "exposure"
	| "contrast"
	| "vibrance"
	| "motionSpeed";
export type AnimatedGradientPreset = {
	id: string;
	name: string;
	config: AnimatedGradientConfig;
};
export type AnimatedGradientStop = {
	color: [number, number, number];
	position: number;
};
export type Annotation = {
	id: string;
	type: AnnotationType;
	x: number;
	y: number;
	width: number;
	height: number;
	strokeColor: string;
	strokeWidth: number;
	fillColor: string;
	opacity: number;
	rotation: number;
	text: string | null;
	maskType?: MaskType | null;
	maskLevel?: number | null;
	points?: [number, number][] | null;
};
export type AnnotationType =
	| "arrow"
	| "circle"
	| "rectangle"
	| "text"
	| "mask"
	| "draw";
export type AppTheme = "system" | "light" | "dark";
export type AspectRatio = "wide" | "vertical" | "square" | "classic" | "tall";
export type Audio = {
	duration: number;
	sample_rate: number;
	channels: number;
	start_time: number;
};
export type AudioConfiguration = {
	mute: boolean;
	improve: boolean;
	isolation: VoiceIsolation;
	micVolumeDb: number;
	micStereoMode: StereoMode;
	systemVolumeDb: number;
};
export type AudioGapSummary = {
	total_overlap_trimmed_ms: number;
	startup_overlap_trimmed_ms?: number;
	overlap_dropped_frames: number;
	startup_overlap_drops: number;
};
export type AudioInputLevelChange = number;
export type AudioLibraryTrack = { id: string; name: string; category: string };
export type AudioMeta = {
	path: string;
	start_time?: number | null;
	device_id?: string | null;
	gap_summary?: AudioGapSummary | null;
};
export type AudioTrackSegment = {
	start: number;
	end: number;
	track?: number;
	path: string;
	name?: string | null;
	enabled?: boolean;
	trimStart?: number;
	volumeDb?: number;
	fadeIn?: number;
	fadeOut?: number;
	duration?: number | null;
};
export type AuthSecret =
	| { api_key: string }
	| { token: string; expires: number };
export type AuthStore = {
	secret: AuthSecret;
	user_id: string | null;
	plan: Plan | null;
	organizations?: Organization[];
	organizations_updated_at?: number | null;
};
export type AutomationActionCheck = {
	actionType: string;
	capability: string;
	supported: boolean;
};
export type AutomationExportCompression =
	| "maximum"
	| "social"
	| "web"
	| "potato";
export type AutomationRecordingMode = "studio" | "instant";
export type AutomationRule = {
	id: string;
	name: string;
	enabled?: boolean;
	trigger: Trigger;
	matchMode?: MatchMode;
	conditions?: Condition[];
	actions?: Action[];
};
export type AutomationTestReport = {
	ruleId: string;
	ruleName: string;
	actionChecks: AutomationActionCheck[];
};
export type AutomationsStore = { version?: number; rules?: AutomationRule[] };
export type BackgroundBlurConfig = { mode: BackgroundBlurMode };
export type BackgroundBlurMode = "off" | "light" | "heavy" | "remove";
export type BackgroundConfiguration = {
	source: BackgroundSource;
	blur: number;
	padding: number;
	paddingMode?: PaddingMode;
	rounding: number;
	roundingType: CornerStyle;
	inset: number;
	crop: Crop | null;
	displayPosition: XY<number> | null;
	shadow: number;
	advancedShadow: ShadowConfiguration | null;
	border: BorderConfiguration | null;
	frame: FrameConfiguration | null;
	notch: NotchConfiguration | null;
};
export type PaddingMode = "proportional" | "even";
export type BackgroundSource =
	| { type: "wallpaper"; path: string | null }
	| { type: "image"; path: string | null }
	| { type: "color"; value: [number, number, number]; alpha?: number }
	| {
			type: "gradient";
			from: [number, number, number];
			to: [number, number, number];
			angle?: number;
			noise_intensity?: number | null;
			noise_scale?: number | null;
			animated?: boolean | null;
			animation_speed?: number | null;
	  }
	| { type: "animatedGradient"; config: AnimatedGradientConfig };
export type BorderConfiguration = {
	enabled: boolean;
	width: number;
	color: [number, number, number];
	opacity: number;
};
export type Camera = {
	hide: boolean;
	mirror: boolean;
	position: CameraPosition;
	manualPosition: XY<number> | null;
	size: number;
	zoomSize: number | null;
	rounding: number;
	shadow: number;
	advancedShadow: ShadowConfiguration | null;
	shape: CameraShape;
	roundingType: CornerStyle;
	scaleDuringZoom?: number;
	backgroundBlur?: BackgroundBlurConfig;
};
export type Camera3DBlur = {
	mode?: Camera3DBlurMode;
	strength?: number;
	falloff?: number;
	focusX?: number;
	focusY?: number;
	focusSize?: number;
	angle?: number;
	dirPosition?: number;
	bokeh?: boolean;
};
export type Camera3DBlurMode = "none" | "radial" | "directional" | "tiltShift";
export type Camera3DKeyframe = {
	time: number;
	value: number;
	outEasing?: [number, number] | null;
	inEasing?: [number, number] | null;
};
export type Camera3DProperties = {
	tiltX?: number;
	tiltY?: number;
	roll?: number;
	rotateX?: number;
	rotateY?: number;
	fov?: number;
	zoom?: number;
	panX?: number;
	panY?: number;
};
export type Camera3DSegment = {
	start: number;
	end: number;
	enabled?: boolean;
	properties?: Camera3DProperties;
	blur?: Camera3DBlur;
	tracks?: Camera3DTracks;
	transitionIn?: number;
	transitionOut?: number;
};
export type Camera3DTracks = {
	tiltX: Camera3DKeyframe[];
	tiltY: Camera3DKeyframe[];
	roll: Camera3DKeyframe[];
	rotateX: Camera3DKeyframe[];
	rotateY: Camera3DKeyframe[];
	fov: Camera3DKeyframe[];
	zoom: Camera3DKeyframe[];
	panX: Camera3DKeyframe[];
	panY: Camera3DKeyframe[];
	blurStrength: Camera3DKeyframe[];
	blurFalloff: Camera3DKeyframe[];
	blurFocusSize: Camera3DKeyframe[];
	blurFocusX: Camera3DKeyframe[];
	blurFocusY: Camera3DKeyframe[];
	blurAngle: Camera3DKeyframe[];
	blurDirPosition: Camera3DKeyframe[];
};
export type CameraDeviceSettings = {
	width: number | null;
	height: number | null;
	frameRate: number | null;
};
export type CameraFormatInfo = {
	width: number;
	height: number;
	frameRate: number;
};
export type CameraInfo = {
	device_id: string;
	model_id: ModelIDType | null;
	display_name: string;
};
export type CameraPosition = { x: CameraXPosition; y: CameraYPosition };
export type CameraPresentationInput = {
	viewportWidth: number;
	viewportHeight: number;
	left: number;
	top: number;
	width: number;
	height: number;
	radius: number;
	layoutRevision: number;
	state: CameraPreviewState;
};
export type CameraPresentationRequested = {
	nonce: string;
	generation: number;
	cameraRevision: string;
};
export type CameraPreviewShape = "round" | "square" | "full";
export type CameraPreviewState = {
	size: number;
	shape: CameraPreviewShape;
	mirrored: boolean;
	background_blur?: BackgroundBlurMode;
};
export type CameraShape = "square" | "source";
export type CameraWithFormats = {
	deviceId: string;
	displayName: string;
	modelId: string | null;
	formats: CameraFormatInfo[];
	bestFormat: CameraFormatInfo | null;
};
export type CameraXPosition = "left" | "center" | "right";
export type CameraYPosition = "top" | "bottom";
export type CaptionData = {
	segments: CaptionSegment[];
	settings: CaptionSettings | null;
};
export type CaptionSegment = {
	id: string;
	start: number;
	end: number;
	text: string;
	words?: CaptionWord[];
};
export type CaptionSettings = {
	enabled: boolean;
	font: string;
	size: number;
	color: string;
	backgroundColor: string;
	backgroundOpacity: number;
	position: string;
	italic: boolean;
	fontWeight: number;
	outline: boolean;
	outlineColor: string;
	exportWithSubtitles: boolean;
	highlightColor: string;
	fadeDuration: number;
	lingerDuration: number;
	wordTransitionDuration: number;
	activeWordHighlight: boolean;
	manualPosition: XY<number> | null;
	preset: string;
	animation: string;
	highlightStyle: string;
	uppercase: boolean;
};
export type CaptionTrackSegment = {
	id: string;
	start: number;
	end: number;
	text: string;
	words?: CaptionWord[];
	fadeDurationOverride?: number | null;
	lingerDurationOverride?: number | null;
	positionOverride?: string | null;
	colorOverride?: string | null;
	backgroundColorOverride?: string | null;
	fontSizeOverride?: number | null;
};
export type CaptionWord = { text: string; start: number; end: number };
export type CaptionsData = {
	segments: CaptionSegment[];
	settings: CaptionSettings;
	sourceTimed?: boolean;
};
export type CaptureDisplay = {
	id: DisplayId;
	name: string;
	refresh_rate: number;
};
export type CaptureDisplayWithThumbnail = {
	id: DisplayId;
	name: string;
	refresh_rate: number;
	thumbnail: string | null;
};
export type CaptureTargetKind = "display" | "window" | "area";
export type CaptureWindow = {
	id: WindowId;
	owner_name: string;
	name: string;
	bounds: LogicalBounds;
	refresh_rate: number;
	bundle_identifier: string | null;
};
export type CaptureWindowWithThumbnail = {
	id: WindowId;
	owner_name: string;
	name: string;
	bounds: LogicalBounds;
	refresh_rate: number;
	thumbnail: string | null;
	app_icon: string | null;
	bundle_identifier: string | null;
};
export type CliInstallStatus = {
	installDir: string;
	shimPath: string;
	targetPath: string;
	installed: boolean;
	onPath: boolean;
	conflict: string | null;
	pathEntry: string;
	shellCommand: string;
	pathConfigured: boolean;
};
export type ClickSpringConfig = {
	tension: number;
	mass: number;
	friction: number;
};
export type ClipConfiguration = {
	index: number;
	offsets: ClipOffsets;
	offsetsAutoCalculated?: boolean;
};
export type ClipOffsets = {
	camera?: number;
	mic?: number;
	system_audio?: number;
};
export type ClipSpeedAudioMode = "mute" | "maintainPitch" | "matchSpeed";
export type ClipTransition = {
	segmentIndex: number;
	type: ClipTransitionType;
	duration: number;
};
export type ClipTransitionType =
	| "cross-fade"
	| "fade-through-black"
	| "fade-through-white"
	| "push-left"
	| "push-right"
	| "push-up"
	| "push-down"
	| "wipe-left"
	| "wipe-right"
	| "wipe-up"
	| "wipe-down"
	| "zoom";
export type ClipboardSource = "raw" | "rendered";
export type ColorCorrection = {
	preset: string;
	intensity: number;
	exposure: number;
	contrast: number;
	saturation: number;
	temperature: number;
	tint: number;
	fade: number;
	splitTone: number;
	vignette: number;
	grain: number;
};
export type ColorCorrectionConfiguration = {
	screen: ColorCorrection;
	camera: ColorCorrection;
	gradeCursor: boolean;
};
export type CommercialLicense = {
	licenseKey: string;
	expiryDate: number | null;
	refresh: number;
	activatedOn: number;
};
export type Condition =
	| { type: "captureTargetIs"; target: CaptureTargetKind }
	| { type: "recordingModeIs"; mode: AutomationRecordingMode }
	| { type: "durationAtLeast"; secs: number }
	| { type: "durationAtMost"; secs: number }
	| { type: "windowTitleContains"; pattern: string }
	| { type: "organizationIs"; id: string };
export type CornerStyle = "squircle" | "rounded";
export type Crop = { position: XY<number>; size: XY<number> };
export type CurrentRecording = {
	target: CurrentRecordingTarget;
	mode: RecordingMode;
	status: RecordingStatus;
};
export type CurrentRecordingChanged = null;
export type CurrentRecordingTarget =
	| { window: { id: WindowId; bounds: LogicalBounds | null } }
	| { screen: { id: DisplayId } }
	| { area: { screen: DisplayId; bounds: LogicalBounds } }
	| "camera";
export type CursorAnimationStyle =
	| "slow"
	| "smooth"
	| "mellow"
	| "fast"
	| "custom";
export type CursorConfiguration = {
	hide: boolean;
	hideWhenIdle: boolean;
	hideWhenIdleDelay: number;
	size: number;
	type: CursorType;
	animationStyle: CursorAnimationStyle;
	tension: number;
	mass: number;
	friction: number;
	raw: boolean;
	motionBlur: number;
	useSvg: boolean;
	rotationAmount?: number;
	baseRotation?: number;
	clickSpring?: ClickSpringConfig | null;
	stopMovementInLastSeconds?: number | null;
	ripple?: CursorRippleConfig;
};
export type CursorMeta = {
	imagePath: string;
	hotspot: XY<number>;
	shape?: string | null;
};
export type CursorRippleConfig = {
	enabled: boolean;
	color: [number, number, number];
	strength: number;
	size: number;
	duration: number;
};
export type CursorType =
	| "auto"
	| "pointer"
	| "circle"
	| "macos"
	| "tahoe"
	| "windows";
export type Cursors =
	| { [key in string]: string }
	| { [key in string]: CursorMeta };
export type DeviceOrModelID = { DeviceID: string } | { ModelID: ModelIDType };
export type DevicesUpdated = {
	cameras: CameraInfo[];
	microphones: string[];
	permissions: OSPermissionsCheck;
};
export type DiagnosticOptions = {
	includeSyncTest: boolean;
	mode: string;
	durationSecs: number | null;
	includeMicrophone: boolean;
	micName: string | null;
	skipExport: boolean;
};
export type DiagnosticProgress = {
	phase: string;
	stage: string | null;
	mode: string | null;
};
export type DiagnosticRunResult = {
	reportPath: string;
	verdict: string | null;
	summary: string | null;
	syncTestError: string | null;
	reportJson: string;
};
export type DisplayId = string;
export type DisplayInformation = {
	name: string | null;
	physical_size: PhysicalSize | null;
	logical_size: LogicalSize | null;
	logical_bounds: LogicalBounds | null;
	refresh_rate: string;
};
export type DisplayNotch = {
	x: number;
	width: number;
	height: number;
};
export type DownloadProgress = { progress: number; message: string };
export type EditorPreviewQuality = "quarter" | "half" | "full";
export type EditorRecordingAdded = {
	editor_path: string;
	recording_path: string;
};
export type EditorRecordingFlowChanged = {
	target: EditorRecordingFlowInfo | null;
};
export type EditorRecordingFlowInfo = {
	projectPath: string;
	projectName: string;
};
export type EditorStateChanged = { playhead_position: number };
export type ExportCompression = "Maximum" | "Social" | "Web" | "Potato";
export type ExportDestination =
	| "projectFolder"
	| { customPath: { dir: string } };
export type ExportEstimates = {
	duration_seconds: number;
	estimated_time_seconds: number;
	estimated_size_mb: number;
	time_range_seconds: [number, number];
	size_range_mb: [number, number];
};
export type ExportFormat = "mp4" | "gif" | "mov";
export type ExportPreviewResult = {
	jpeg_base64: string;
	estimated_size_mb: number;
	actual_width: number;
	actual_height: number;
	frame_render_time_ms: number;
	total_frames: number;
};
export type ExportPreviewSettings = {
	fps: number;
	resolution_base: XY<number>;
	compression_bpp: number;
	cursor_only?: boolean;
};
export type ExportProfile = {
	format: ExportFormat;
	fps?: number;
	resolutionBase?: XY<number>;
	compression?: AutomationExportCompression | null;
	presetName?: string | null;
};
export type ExportSettings =
	| ({ format: "Mp4" } & Mp4ExportSettings)
	| ({ format: "Gif" } & GifExportSettings)
	| ({ format: "Mov" } & MovExportSettings);
export type FileType = "recording" | "screenshot";
export type Flags = { captions: boolean };
export type FrameConfiguration = {
	style: FrameStyle;
	theme: FrameTheme;
	url: string;
	title: string;
};
export type FrameLayoutEvent = {
	display: [number, number, number, number];
	camera: [number, number, number, number] | null;
	output_width: number;
	output_height: number;
};
export type FrameStyle = "none" | "macOS" | "windows" | "browser" | "macbook";
export type FrameTheme = "dark" | "light";
export type FramesRendered = {
	renderedCount: number;
	totalFrames: number;
	type: "FramesRendered";
};
export type GeneralSettingsStore = {
	instanceId?: string;
	uploadIndividualFiles?: boolean;
	hideDockIcon?: boolean;
	autoCreateShareableLink?: boolean;
	enableNotifications?: boolean;
	disableAutoOpenLinks?: boolean;
	hasCompletedStartup?: boolean;
	theme?: AppTheme;
	commercialLicense?: CommercialLicense | null;
	lastVersion?: string | null;
	windowTransparency?: boolean;
	postStudioRecordingBehaviour?: PostStudioRecordingBehaviour;
	mainWindowRecordingStartBehaviour?: MainWindowRecordingStartBehaviour;
	custom_cursor_capture2?: boolean;
	serverUrl?: string;
	recordingCountdown?: number | null;
	enableNativeCameraPreview: boolean;
	autoZoomOnClicks?: boolean;
	defaultZoomAmount?: number | null;
	macbookNotchOverlay?: boolean | null;
	captureKeyboardEvents?: boolean;
	postDeletionBehaviour?: PostDeletionBehaviour;
	excludedWindows?: WindowExclusion[];
	deleteInstantRecordingsAfterUpload?: boolean;
	instantModeMaxResolution?: number;
	defaultProjectNameTemplate?: string | null;
	crashRecoveryRecording?: boolean;
	maxFps?: number;
	transcriptionHints?: string[];
	editorPreviewQuality?: EditorPreviewQuality;
	studioRecordingQuality?: StudioRecordingQuality;
	mainWindowPosition?: WindowPosition | null;
	cameraWindowPosition?: WindowPosition | null;
	cameraWindowPositionsByMonitorName?: { [key in string]: WindowPosition };
	hasCompletedOnboarding?: boolean;
	enableTelemetry?: boolean;
	outOfProcessMuxer?: boolean;
	recordingsPath?: string | null;
	previousRecordingsPaths?: string[];
	cameraBlurDisabledByCrash?: string | null;
	updateChannel?: UpdateChannel;
	enableGpuiApp?: boolean;
};
export type GifExportSettings = {
	fps: number;
	resolution_base: XY<number>;
	quality: GifQuality | null;
};
export type GifQuality = {
	quality: number | null;
	fast: boolean | null;
};
export type GlideDirection = "none" | "left" | "right" | "up" | "down";
export type HapticPattern = "alignment" | "levelChange" | "generic";
export type HapticPerformanceTime = "default" | "now" | "drawCompleted";
export type Hotkey = {
	code: string;
	meta: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
};
export type HotkeyAction =
	| "startStudioRecording"
	| "startInstantRecording"
	| "stopRecording"
	| "restartRecording"
	| "togglePauseRecording"
	| "cycleRecordingMode"
	| "openRecordingPicker"
	| "openRecordingPickerDisplay"
	| "openRecordingPickerWindow"
	| "openRecordingPickerArea"
	| "screenshotDisplay"
	| "screenshotWindow"
	| "screenshotArea"
	| "other";
export type HotkeysConfiguration = { show: boolean };
export type HotkeysStore = { hotkeys: { [key in HotkeyAction]: Hotkey } };
export type ImageSegment = {
	start: number;
	end: number;
	track: number;
	enabled: boolean;
	path: string;
	name: string;
	center: XY<number>;
	size: XY<number>;
	opacity: number;
	rotation: number;
	rounding: number;
	flipX: boolean;
	flipY: boolean;
	lockAspect: boolean;
};
export type ImportStage =
	| "Probing"
	| "Converting"
	| "Finalizing"
	| "Complete"
	| "Failed";
export type ImportedAudioTrack = {
	path: string;
	name: string;
	duration: number;
};
export type IncompleteRecordingInfo = {
	projectPath: string;
	prettyName: string;
	segmentCount: number;
	estimatedDurationSecs: number;
};
export type InstantRecordingMeta =
	| { recording: boolean }
	| { error: string }
	| { fps: number; sample_rate: number | null };
export type JsonValue<T> = [T];
export type KeyPressDisplay = { key: string; timeOffset: number };
export type KeyboardData = { settings: KeyboardSettings };
export type KeyboardSettings = {
	enabled: boolean;
	font: string;
	size: number;
	color: string;
	backgroundColor: string;
	backgroundOpacity: number;
	position: string;
	fontWeight: number;
	fadeDuration: number;
	lingerDuration: number;
	groupingThresholdMs: number;
	showModifiers: boolean;
	showSpecialKeys: boolean;
	uppercase: boolean;
};
export type KeyboardTrackSegment = {
	id: string;
	start: number;
	end: number;
	displayText: string;
	keys?: KeyPressDisplay[];
	fadeDurationOverride?: number | null;
	positionOverride?: string | null;
	colorOverride?: string | null;
	backgroundColorOverride?: string | null;
	fontSizeOverride?: number | null;
	uppercaseOverride?: boolean | null;
};
export type LogicalBounds = { position: LogicalPosition; size: LogicalSize };
export type LogicalPosition = { x: number; y: number };
export type LogicalSize = { width: number; height: number };
export type MacOSVersionInfo = {
	major: number;
	minor: number;
	patch: number;
	displayName: string;
	buildNumber: string;
	isAppleSilicon: boolean;
};
export type MainWindowRecordingStartBehaviour = "close" | "minimise";
export type MaskKeyframes = {
	position?: MaskVectorKeyframe[];
	size?: MaskVectorKeyframe[];
	intensity?: MaskScalarKeyframe[];
};
export type MaskKind = "sensitive" | "highlight";
export type MaskScalarKeyframe = { time: number; value: number };
export type MaskSegment = {
	start: number;
	end: number;
	track?: number;
	enabled?: boolean;
	maskType: MaskKind;
	center: XY<number>;
	size: XY<number>;
	feather?: number;
	opacity?: number;
	pixelation?: number;
	darkness?: number;
	fadeDuration?: number;
	keyframes?: MaskKeyframes;
};
export type MaskType = "blur" | "pixelate";
export type MaskVectorKeyframe = { time: number; x: number; y: number };
export type MatchMode = "all" | "any";
export type MicrophoneDeviceSettings = {
	sampleRate: number | null;
	channels: number | null;
};
export type MicrophoneFormatInfo = { sampleRate: number; channels: number };
export type MicrophoneInfo = {
	name: string;
	sampleRate: number;
	channels: number;
	formats: MicrophoneFormatInfo[];
};
export type ModelDownloadState = "downloading" | "completed" | "failed";
export type ModelDownloadStatus = {
	state: ModelDownloadState;
	progress: number;
	message: string;
};
export type ModelIDType = string;
export type MovExportSettings = {
	fps: number;
	resolution_base: XY<number>;
	cursor_only?: boolean;
};
export type Mp4ExportSettings = {
	fps: number;
	resolution_base: XY<number>;
	compression: ExportCompression;
	custom_bpp: number | null;
	force_ffmpeg_decoder?: boolean;
	optimize_filesize?: boolean;
};
export type MultipleSegment = {
	display: VideoMeta;
	camera?: VideoMeta | null;
	mic?: AudioMeta | null;
	system_audio?: AudioMeta | null;
	cursor?: string | null;
	keyboard?: string | null;
	display_notch?: DisplayNotch | null;
};
export type MultipleSegments = {
	segments: MultipleSegment[];
	cursors: Cursors;
	status?: StudioRecordingStatus | null;
};
export type NewNotification = {
	title: string;
	body: string;
	is_error: boolean;
};
export type NewScreenshotAdded = { path: string };
export type NewStudioRecordingAdded = { path: string };
export type NotchConfiguration = {
	enabled: boolean;
	x: number | null;
	width: number | null;
	height: number | null;
};
export type OSPermission =
	| "screenRecording"
	| "camera"
	| "microphone"
	| "accessibility";
export type OSPermissionStatus = "notNeeded" | "empty" | "granted" | "denied";
export type OSPermissionsCheck = {
	screenRecording: OSPermissionStatus;
	microphone: OSPermissionStatus;
	camera: OSPermissionStatus;
	accessibility: OSPermissionStatus;
};
export type OnEscapePress = null;
export type Organization = {
	id: string;
	name: string;
	ownerId: string;
	role?: string;
	canEditBrand?: boolean;
	iconUrl?: string | null;
	brandColors?: OrganizationBrandColors;
};
export type OrganizationBrandColors = {
	primary: string | null;
	secondary: string | null;
	accent: string | null;
	background: string | null;
};
export type OverlayTrack = { kind: OverlayTrackKind; track: number };
export type OverlayTrackKind = "mask" | "image" | "text" | "waveform";
export type Phase =
	| "awaitingShortcut"
	| "starting"
	| "recording"
	| "pausing"
	| "paused"
	| "resuming"
	| "resumeFailed"
	| "restarting"
	| "stopping"
	| "restoring";
export type PhysicalSize = { width: number; height: number };
export type Plan = { upgraded: boolean; manual: boolean; last_checked: number };
export type Platform = "MacOS" | "Windows" | "Linux";
export type PostDeletionBehaviour = "doNothing" | "reopenRecordingWindow";
export type PostStudioRecordingBehaviour = "openEditor" | "showOverlay";
export type PreparingEditorChanged = {
	requestEpoch: number;
	jobId: string;
	sequence: number;
	fps: number;
	progress: PreparingEditorProgress;
	playback: PreparingPlaybackState;
	seed: PreparingEditorSeed;
};
export type PreparingEditorPhase =
	| "preparing"
	| "handoff"
	| "unavailable"
	| "ready";
export type PreparingEditorProgress = {
	totalDuration: number | null;
	playableUntil: number;
	previewAvailable: boolean;
	phase: PreparingEditorPhase;
};
export type PreparingEditorSeed = { title: string; tracks: string[] };
export type PreparingPlaybackState = {
	playheadSeconds: number;
	playing: boolean;
	buffering: boolean;
};
export type Preset = { name: string; config: ProjectConfiguration };
export type PresetsStore = { presets: Preset[]; default: number | null };
export type ProjectConfiguration = {
	aspectRatio: AspectRatio | null;
	background: BackgroundConfiguration;
	camera: Camera;
	audio: AudioConfiguration;
	cursor: CursorConfiguration;
	hotkeys: HotkeysConfiguration;
	timeline: TimelineConfiguration | null;
	overlayOrder: OverlayTrack[];
	hideDisplay?: boolean;
	captions: CaptionsData | null;
	keyboard: KeyboardData | null;
	clips: ClipConfiguration[];
	annotations: Annotation[];
	screenMotionBlur?: number;
	screenMovementSpring?: ScreenMovementSpring;
	colorCorrection?: ColorCorrectionConfiguration;
	textSizeVersion?: number;
	textAnimVersion?: number;
};
export type ProjectRecordingsMeta = { segments: SegmentRecordings[] };
export type RecordingAction =
	| "Started"
	| "InvalidAuthentication"
	| "UpgradeRequired";
export type RecordingDeleted = { path: string };
export type RecordingEvent =
	| { variant: "Countdown"; value: number }
	| { variant: "Started" }
	| { variant: "Stopped" }
	| { variant: "Paused" }
	| { variant: "Resumed" }
	| { variant: "Failed"; error: string }
	| { variant: "StartFailed"; error: string }
	| { variant: "InputLost"; input: RecordingInputKind }
	| { variant: "InputRestored"; input: RecordingInputKind }
	| { variant: "Degraded"; reason: string }
	| { variant: "Recovered" };
export type RecordingInputKind = "microphone" | "camera";
export type RecordingMeta = (StudioRecordingMeta | InstantRecordingMeta) & {
	platform?: Platform | null;
	pretty_name: string;
	sharing?: SharingMeta | null;
	upload?: UploadMeta | null;
};
export type RecordingMetaWithMetadata = ((
	| StudioRecordingMeta
	| InstantRecordingMeta
) & {
	platform?: Platform | null;
	pretty_name: string;
	sharing?: SharingMeta | null;
	upload?: UploadMeta | null;
}) & {
	mode: RecordingMode;
	status: StudioRecordingStatus;
	clip_count: number;
	sort_time_millis: number;
};
export type RecordingMode = "studio" | "instant" | "screenshot";
export type RecordingOptionsChanged = null;
export type RecordingSettingsStore = {
	target: ScreenCaptureTarget | null;
	micName: string | null;
	cameraId: DeviceOrModelID | null;
	mode: RecordingMode | null;
	systemAudio: boolean;
	organizationId: string | null;
	cameraDeviceSettings: { [key in string]: CameraDeviceSettings };
	microphoneDeviceSettings: { [key in string]: MicrophoneDeviceSettings };
};
export type RecordingStarted = null;
export type RecordingStatus = "pending" | "recording";
export type RecordingStopped = null;
export type RecordingTargetMode = "display" | "window" | "area" | "camera";
export type RecordingsMigrationFailure = { name: string; error: string };
export type RecordingsMigrationProgress = {
	total: number;
	done: number;
	current: string | null;
};
export type RecordingsMigrationSummary = {
	moved: number;
	skippedInUse: number;
	failed: RecordingsMigrationFailure[];
};
export type RenderFrameEvent = {
	frame_number: number;
	fps: number;
	resolution_base: XY<number>;
};
export type RequestOpenRecordingPicker = {
	target_mode: RecordingTargetMode | null;
};
export type RequestOpenSettings = { page: string };
export type RequestScreenCapturePrewarm = { force?: boolean };
export type RequestScrollToSettingsSection = { section: string };
export type RequestSetTargetMode = {
	target_mode: RecordingTargetMode | null;
	display_id: string | null;
};
export type RequestStartRecording = { mode: RecordingMode };
export type S3UploadMeta = { id: string };
export type SceneMode =
	| "default"
	| "cameraOnly"
	| "hideCamera"
	| "splitScreen"
	| "floating";
export type SceneSegment = {
	start: number;
	end: number;
	mode?: SceneMode;
	splitLayout?: SplitLayout | null;
	transitionIn?: number;
	transitionOut?: number;
};
export type ScreenCaptureTarget =
	| { variant: "window"; id: WindowId }
	| { variant: "display"; id: DisplayId }
	| { variant: "area"; screen: DisplayId; bounds: LogicalBounds }
	| { variant: "cameraOnly" };
export type ScreenMovementSpring = {
	stiffness: number;
	damping: number;
	mass: number;
};
export type ScreenshotMetaWithMetadata = ((
	| StudioRecordingMeta
	| InstantRecordingMeta
) & {
	platform?: Platform | null;
	pretty_name: string;
	sharing?: SharingMeta | null;
	upload?: UploadMeta | null;
}) & { sort_time_millis: number };
export type ScreenshotOcrLine = {
	text: string;
	confidence: number | null;
	bounds: ScreenshotOcrRegion;
};
export type ScreenshotOcrRegion = {
	x: number;
	y: number;
	width: number;
	height: number;
};
export type ScreenshotOcrResult = {
	text: string;
	lines: ScreenshotOcrLine[];
	engine: string;
};
export type ScreenshotProjectExport = {
	imageBytes: number[];
	config: ProjectConfiguration;
	imageWidth: number;
	imageHeight: number;
};
export type ScreenshotProjectShareState = {
	config: ProjectConfiguration;
	sharing: ScreenshotSharingState | null;
};
export type ScreenshotSharingState = {
	link: string;
	contentHash: string | null;
};
export type SegmentRecordings = {
	display: Video;
	camera: Video | null;
	mic: Audio | null;
	system_audio: Audio | null;
};
export type SerializedEditorInstance = {
	instanceId: string;
	preparingPlayback: boolean;
	framesSocketUrl: string;
	preparingSnapshot: PreparingEditorChanged | null;
	recordingDuration: number;
	savedProjectConfig: ProjectConfiguration;
	recordings: ProjectRecordingsMeta;
	path: string;
	notchBase: DisplayNotch;
};
export type SerializedScreenshotEditorInstance = {
	framesSocketUrl: string;
	path: string;
	config: ProjectConfiguration | null;
	prettyName: string;
	imageWidth: number;
	imageHeight: number;
};
export type SetCaptureAreaPending = boolean;
export type ShadowConfiguration = {
	size: number;
	opacity: number;
	blur: number;
};
export type SharingMeta = {
	id: string;
	link: string;
	content_hash?: string | null;
};
export type ShowCapWindow =
	| { Main: { init_target_mode: RecordingTargetMode | null } }
	| { Settings: { page: string | null } }
	| { Editor: { project_path: string } }
	| "RecordingsOverlay"
	| { WindowCaptureOccluder: { screen_id: DisplayId } }
	| {
			TargetSelectOverlay: {
				display_id: DisplayId;
				target_mode: RecordingTargetMode | null;
			};
	  }
	| { CaptureArea: { screen_id: DisplayId } }
	| { Camera: { centered: boolean } }
	| {
			InProgressRecording: {
				countdown: number | null;
				capture_target?: ScreenCaptureTarget | null;
			};
	  }
	| "Upgrade"
	| "ModeSelect"
	| { ScreenshotEditor: { path: string } }
	| "Onboarding";
export type SingleSegment = {
	display: VideoMeta;
	camera?: VideoMeta | null;
	audio?: AudioMeta | null;
	cursor?: string | null;
};
export type Snapshot = {
	generation: number;
	phase: Phase | null;
	mode: RecordingMode | null;
	shortcut: string | null;
	error: string | null;
};
export type SplitLayout = {
	screenZoom: number;
	screenPosition: XY<number>;
	cameraZoom: number;
	cameraPosition: XY<number>;
};
export type StartRecordingInputs = {
	capture_target: ScreenCaptureTarget;
	capture_system_audio?: boolean;
	mode: RecordingMode;
	organization_id?: string | null;
};
export type StereoMode = "stereo" | "monoL" | "monoR";
export type StudioRecordingMeta =
	| { segment: SingleSegment }
	| { inner: MultipleSegments };
export type StudioRecordingQuality = "compatibility" | "balanced" | "ultra";
export type StudioRecordingStatus =
	| { status: "InProgress" }
	| { status: "NeedsRemux" }
	| { status: "Failed"; error: string }
	| { status: "Complete" };
export type StyleOverrides = {
	background?: BackgroundConfiguration | null;
	camera?: Camera | null;
	cursor?: CursorConfiguration | null;
	cameraOnlyPadding?: number | null;
};
export type StyleSegment = {
	start: number;
	end: number;
	track: number;
	enabled: boolean;
	name: string;
	overrides: StyleOverrides;
};
export type SystemDiagnostics = {
	macosVersion: MacOSVersionInfo | null;
	availableEncoders: string[];
	screenCaptureSupported: boolean;
	metalSupported: boolean;
	gpuName: string | null;
};
export type TargetUnderCursor = {
	display_id: DisplayId | null;
	window: WindowUnderCursor | null;
};
export type TextAlign = "left" | "center" | "right";
export type TextAnimation =
	| "none"
	| "fade"
	| "slideUp"
	| "slideDown"
	| "slideLeft"
	| "slideRight"
	| "pop"
	| "zoom"
	| "bounce"
	| "wipe"
	| "words"
	| "letters"
	| "tracking"
	| "typewriter";
export type TextBackgroundStyle = "box" | "pill" | "highlight";
export type TextLayout = "overlay" | "fullscreen" | "splitLeft" | "splitRight";
export type TextSegment = {
	start: number;
	end: number;
	track?: number;
	enabled?: boolean;
	content?: string;
	center?: XY<number>;
	size?: XY<number>;
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: number;
	italic?: boolean;
	color?: string;
	backgroundColor?: string | null;
	backgroundStyle?: TextBackgroundStyle;
	uppercase?: boolean;
	strokeWidth?: number;
	strokeColor?: string;
	gradientColor?: string | null;
	glow?: number;
	fadeDuration?: number;
	align?: TextAlign;
	letterSpacing?: number;
	lineHeight?: number;
	opacity?: number;
	shadow?: number;
	animationIn?: TextAnimation;
	animationOut?: TextAnimation;
	animationInDuration?: number;
	animationOutDuration?: number;
	layout?: TextLayout;
	layoutTransition?: number;
};
export type TimelineConfiguration = {
	segments: TimelineSegment[];
	transitions: ClipTransition[];
	zoomSegments: ZoomSegment[];
	sceneSegments?: SceneSegment[];
	maskSegments?: MaskSegment[];
	textSegments?: TextSegment[];
	captionSegments?: CaptionTrackSegment[];
	keyboardSegments?: KeyboardTrackSegment[];
	audioSegments?: AudioTrackSegment[];
	styleSegments: StyleSegment[];
	imageSegments: ImageSegment[];
	camera3dSegments?: Camera3DSegment[];
	waveformSegments?: WaveformSegment[];
};
export type TimelineSegment = {
	recordingSegment?: number;
	timescale: number;
	start: number;
	end: number;
	name?: string | null;
	speedAudioMode?: ClipSpeedAudioMode | null;
	volume?: number | null;
	hideCursor?: boolean | null;
};
export type TranscriptionEngine = "Whisper" | "Parakeet";
export type Trigger =
	| "screenshotTaken"
	| "studioRecordingFinished"
	| "instantRecordingFinished"
	| "recordingStarted"
	| "uploadCompleted"
	| "videoImported"
	| "recordingDeleted";
export type UpdateChannel = "stable" | "nightly";
export type UpdateCheckResult = {
	version: string;
	notes: string | null;
	channel: UpdateChannel;
};
export type UpdateDownloadProgress = {
	downloaded: number;
	total: number | null;
};
export type UpdateReady = { version: string; installed: boolean };
export type UploadMeta =
	| {
			state: "MultipartUpload";
			video_id: string;
			file_path: string;
			pre_created_video: VideoUploadInfo;
			recording_dir: string;
	  }
	| {
			state: "SinglePartUpload";
			video_id: string;
			recording_dir: string;
			file_path: string;
			screenshot_path: string;
	  }
	| {
			state: "SegmentUpload";
			video_id: string;
			pre_created_video: VideoUploadInfo;
			recording_dir: string;
	  }
	| { state: "Failed"; error: string }
	| { state: "Complete" };
export type UploadMode =
	| { Initial: { pre_created_video: VideoUploadInfo | null } }
	| "Reupload";
export type UploadProgress = { progress: number };
export type UploadProgressEvent = {
	video_id: string;
	uploaded: string;
	total: string;
};
export type UploadResult =
	| { Success: string }
	| "NotAuthenticated"
	| "PlanCheckFailed"
	| "UpgradeRequired";
export type Video = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	start_time: number;
};
export type VideoImportProgress = {
	project_path: string;
	stage: ImportStage;
	progress: number;
	message: string;
};
export type VideoMeta = {
	path: string;
	fps?: number;
	start_time?: number | null;
	device_id?: string | null;
};
export type VideoRecordingMetadata = { duration: number; size: number };
export type VideoUploadInfo = {
	id: string;
	link: string;
	config: S3UploadMeta;
};
export type VoiceIsolation = "light" | "balanced" | "strong";
export type WaveformSegment = {
	start: number;
	end: number;
	track: number;
	enabled: boolean;
	center: XY<number>;
	size: XY<number>;
	opacity: number;
	style: WaveformStyle;
	color: string;
	secondaryColor: string | null;
	barCount: number;
	barWidth: number;
	rounding: number;
	sensitivity: number;
	smoothing: number;
	source: WaveformSource;
};
export type WaveformSource = "mix" | "mic" | "system";
export type WaveformStyle = "bars" | "mirrored" | "line" | "dots";
export type WindowExclusion = {
	bundleIdentifier?: string | null;
	ownerName?: string | null;
	windowTitle?: string | null;
};
export type WindowId = string;
export type WindowPosition = {
	x: number;
	y: number;
	displayId?: DisplayId | null;
};
export type WindowUnderCursor = {
	id: WindowId;
	app_name: string;
	bounds: LogicalBounds;
};
export type XY<T> = { x: T; y: T };
export type ZoomMode = "auto" | { manual: { x: number; y: number } };
export type ZoomSegment = {
	start: number;
	end: number;
	amount: number;
	mode: ZoomMode;
	glideDirection?: GlideDirection;
	glideSpeed?: number;
	instantAnimation?: boolean;
	edgeSnapRatio?: number;
};

export type Result<T, E> =
	| { status: "ok"; data: T }
	| { status: "error"; error: E };
