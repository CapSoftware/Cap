import {
	ChevronDown,
	EyeOff,
	Mic,
	MicOff,
	Pause,
	Pencil,
	Play,
	Square,
	Video,
	VideoOff,
	X,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { formatDuration } from "../shared/format-duration";
import {
	isOverlayMessage,
	isRecordingStatusBroadcast,
} from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";
import {
	AUTH_KEY,
	loadAuth,
	loadOverlayUiState,
	loadSettings,
	loadSharedRecordingState,
	loadSharedUiState,
	OVERLAY_UI_STATE_KEY,
	RECORDING_STATE_KEY,
	SHARED_UI_STATE_KEY,
	updateOverlayUiState,
	updateSharedUiState,
} from "../shared/storage";
import type {
	MicrophoneSettings,
	OverlayPosition,
	RecordingPlan,
	RecordingStatus,
	SharedRecordingState,
	WebcamSettings,
} from "../shared/types";
import { BlurOverlay } from "./blur-overlay";
import { DrawingOverlay } from "./drawing-overlay";

const EDGE_PADDING = 16;
const BOTTOM_OFFSET = 28;
const POLL_INTERVAL_MS = 5000;
const WARNING_THRESHOLD_MS = 60_000;
const LOGO_URL = chrome.runtime.getURL("icons/icon-48.png");

type BarStatus = {
	phase: "recording" | "paused";
	durationMs: number;
	updatedAt: number;
};

type BarControl = "stop-recording" | "pause-recording" | "resume-recording";

type RecordingBarOverlayProps = {
	recorderPanelOpen: boolean;
	webcam?: WebcamSettings | null;
	microphone?: MicrophoneSettings | null;
	onToggleWebcam?: () => void;
	onUpdateWebcamShape?: () => void;
	onToggleMicrophone?: () => void;
};

const toBarStatus = (status: RecordingStatus | undefined): BarStatus | null => {
	if (!status) return null;
	if (status.phase !== "recording" && status.phase !== "paused") return null;
	return {
		phase: status.phase,
		durationMs: status.durationMs,
		updatedAt: status.updatedAt ?? status.startedAt,
	};
};

const classNames = (...values: Array<string | false | null | undefined>) =>
	values.filter(Boolean).join(" ");

const toOverlayPosition = (position: {
	x: number;
	y: number;
}): OverlayPosition => ({
	...position,
	viewportWidth: window.innerWidth,
	viewportHeight: window.innerHeight,
	updatedAt: Date.now(),
});

const currentDurationMs = (status: BarStatus, now: number) =>
	status.phase === "recording"
		? status.durationMs + Math.max(0, now - status.updatedAt)
		: status.durationMs;

export function RecordingBarOverlay({
	recorderPanelOpen,
	webcam,
	microphone,
	onToggleWebcam,
	onUpdateWebcamShape,
	onToggleMicrophone,
}: RecordingBarOverlayProps) {
	const [status, setStatus] = useState<BarStatus | null>(null);
	const [plan, setPlan] = useState<RecordingPlan | null>(null);
	const [signedIn, setSignedIn] = useState(false);
	const [readyDismissed, setReadyDismissed] = useState(false);
	const [countdownValue, setCountdownValue] = useState<number | null>(null);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [persistedBarPosition, setPersistedBarPosition] =
		useState<OverlayPosition | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [drawing, setDrawing] = useState(false);
	const [blurActive, setBlurActive] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const dragOffsetRef = useRef({ x: 0, y: 0 });
	const dragDistanceRef = useRef(0);
	const dragStartPosRef = useRef({ x: 0, y: 0 });
	const isPointerDownRef = useRef(false);
	const barRef = useRef<HTMLDivElement>(null);
	const planRef = useRef<RecordingPlan | null>(null);
	const positionRef = useRef<{ x: number; y: number } | null>(null);
	const positionModeRef = useRef<"active" | "ready" | null>(null);
	const recorderPanelOpenRef = useRef(false);
	const countdownIntervalRef = useRef<number | null>(null);
	const hoverTimeoutRef = useRef<number | null>(null);

	useEffect(() => {
		planRef.current = plan;
	}, [plan]);

	useEffect(() => {
		positionRef.current = position;
	}, [position]);

	const applyResponse = useCallback(
		(nextStatus: RecordingStatus | undefined, nextPlan?: RecordingPlan) => {
			if (nextPlan) setPlan(nextPlan);
			setStatus(toBarStatus(nextStatus));
			setNow(Date.now());
		},
		[],
	);

	const applySharedState = useCallback(
		(state: SharedRecordingState | null) => {
			if (!state) return;
			applyResponse(state.status, state.plan ?? undefined);
		},
		[applyResponse],
	);

	const refresh = useCallback(() => {
		sendServiceWorkerMessage({
			target: "service-worker",
			type: "get-recording-status",
		})
			.then((response) => {
				if (response.ok) applyResponse(response.status, response.plan);
			})
			.catch(() => undefined);
	}, [applyResponse]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => {
		if (recorderPanelOpen && !recorderPanelOpenRef.current) {
			refresh();
		}
		recorderPanelOpenRef.current = recorderPanelOpen;
	}, [recorderPanelOpen, refresh]);

	useEffect(() => {
		let disposed = false;

		const syncOverlayUiState = () => {
			loadOverlayUiState()
				.then((state) => {
					if (!disposed) {
						setPersistedBarPosition(state.recordingBarPosition);
					}
				})
				.catch(() => undefined);
		};

		const syncSharedRecordingState = () => {
			loadSharedRecordingState()
				.then((state) => {
					if (!disposed) applySharedState(state);
				})
				.catch(() => undefined);
		};

		const syncSharedUiState = () => {
			loadSharedUiState()
				.then((state) => {
					if (!disposed) setReadyDismissed(state.readyBarDismissed);
				})
				.catch(() => undefined);
		};

		const syncAuthState = () => {
			loadAuth()
				.then((auth) => {
					if (!disposed) setSignedIn(auth !== null);
				})
				.catch(() => undefined);
		};

		const handleStorageChange = (
			changes: Record<string, chrome.storage.StorageChange>,
			areaName: string,
		) => {
			if (areaName === "local" && changes[OVERLAY_UI_STATE_KEY]) {
				syncOverlayUiState();
			}
			if (areaName === "local" && changes[AUTH_KEY]) {
				syncAuthState();
			}
			if (areaName === "session" && changes[RECORDING_STATE_KEY]) {
				syncSharedRecordingState();
			}
			if (areaName === "session" && changes[SHARED_UI_STATE_KEY]) {
				syncSharedUiState();
			}
		};

		syncOverlayUiState();
		syncSharedRecordingState();
		syncSharedUiState();
		syncAuthState();
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			disposed = true;
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, [applySharedState]);

	useEffect(() => {
		const handleVisibility = () => {
			if (document.visibilityState !== "visible") return;
			setNow(Date.now());
			loadSharedRecordingState()
				.then((state) => applySharedState(state))
				.catch(() => undefined);
		};
		document.addEventListener("visibilitychange", handleVisibility);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibility);
	}, [applySharedState]);

	useEffect(() => {
		const clearCountdownTimer = () => {
			if (countdownIntervalRef.current !== null) {
				window.clearInterval(countdownIntervalRef.current);
				countdownIntervalRef.current = null;
			}
		};

		const handleMessage = (message: unknown) => {
			if (isRecordingStatusBroadcast(message)) {
				applyResponse(message.status);
				if (!planRef.current) refresh();
				return false;
			}
			if (isOverlayMessage(message)) {
				if (message.type === "overlay-countdown") {
					clearCountdownTimer();
					setCountdownValue(message.seconds);
					let cur = message.seconds;
					const perNum = message.durationMs / message.seconds;
					countdownIntervalRef.current = window.setInterval(() => {
						cur -= 1;
						if (cur <= 0) {
							clearCountdownTimer();
							setCountdownValue(null);
							return;
						}
						setCountdownValue(cur);
					}, perNum);
					return false;
				}
				if (message.type === "overlay-hide") {
					clearCountdownTimer();
					setCountdownValue(null);
					refresh();
					return false;
				}
				refresh();
				return false;
			}
			return false;
		};
		chrome.runtime.onMessage.addListener(handleMessage);
		return () => {
			clearCountdownTimer();
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, [applyResponse, refresh]);

	const active = status !== null || countdownValue !== null;
	const ready = signedIn && !active && recorderPanelOpen && !readyDismissed;
	const visible = active || ready;

	useEffect(() => {
		if (!visible) {
			setDrawing(false);
			setBlurActive(false);
			setIsExpanded(false);
		}
	}, [visible]);

	useEffect(() => {
		if (status === null) return;
		setNow(Date.now());
		const interval = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(interval);
	}, [status]);

	useEffect(() => {
		if (status === null) return;
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") refresh();
		}, POLL_INTERVAL_MS);
		return () => window.clearInterval(interval);
	}, [status, refresh]);

	const clampToViewport = useCallback(
		(value: { x: number; y: number }) => {
			const rect = barRef.current?.getBoundingClientRect();
			const width = rect?.width ?? (active ? 60 : 380);
			const height = rect?.height ?? (active ? 60 : 64);
			const maxX = Math.max(
				EDGE_PADDING,
				window.innerWidth - width - EDGE_PADDING,
			);
			const maxY = Math.max(
				EDGE_PADDING,
				window.innerHeight - height - EDGE_PADDING,
			);
			return {
				x: Math.min(Math.max(value.x, EDGE_PADDING), maxX),
				y: Math.min(Math.max(value.y, EDGE_PADDING), maxY),
			};
		},
		[active],
	);

	useEffect(() => {
		if (!visible || isDragging) return;
		const bar = barRef.current;
		if (!bar) return;
		const mode = active ? "active" : "ready";
		if (positionModeRef.current !== mode) {
			positionModeRef.current = mode;
			if (!persistedBarPosition) positionRef.current = null;
		}
		const reposition = () => {
			const rect = bar.getBoundingClientRect();
			if (rect.width === 0) return;
			const restored = persistedBarPosition
				? {
						x: persistedBarPosition.x,
						y: persistedBarPosition.y,
					}
				: (positionRef.current ??
					(active
						? {
								x: EDGE_PADDING,
								y: window.innerHeight - 90,
							}
						: {
								x: (window.innerWidth - rect.width) / 2,
								y: window.innerHeight - rect.height - BOTTOM_OFFSET,
							}));
			const nextPosition = clampToViewport(restored);
			positionRef.current = nextPosition;
			setPosition(nextPosition);
		};
		reposition();
		const observer = new ResizeObserver(reposition);
		observer.observe(bar);
		return () => observer.disconnect();
	}, [active, clampToViewport, persistedBarPosition, isDragging, visible]);

	useEffect(() => {
		if (!visible) return;
		const handleResize = () => {
			setPosition((previous) =>
				previous ? clampToViewport(previous) : previous,
			);
		};
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [clampToViewport, visible]);

	const handlePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if ((event.target as HTMLElement).closest("[data-controls]")) return;
			isPointerDownRef.current = true;
			dragDistanceRef.current = 0;
			dragStartPosRef.current = { x: event.clientX, y: event.clientY };
			dragOffsetRef.current = {
				x: event.clientX - (position?.x ?? EDGE_PADDING),
				y: event.clientY - (position?.y ?? EDGE_PADDING),
			};
		},
		[position],
	);

	useEffect(() => {
		const handlePointerMove = (event: PointerEvent) => {
			if (!isPointerDownRef.current) return;
			const dist = Math.hypot(
				event.clientX - dragStartPosRef.current.x,
				event.clientY - dragStartPosRef.current.y,
			);
			dragDistanceRef.current = dist;
			if (dist > 4) {
				setIsDragging(true);
				setPosition(
					clampToViewport({
						x: event.clientX - dragOffsetRef.current.x,
						y: event.clientY - dragOffsetRef.current.y,
					}),
				);
			}
		};

		const handlePointerUp = (_event: PointerEvent) => {
			if (!isPointerDownRef.current) return;
			isPointerDownRef.current = false;
			setIsDragging(false);
			const nextPosition = positionRef.current;
			if (!nextPosition) return;
			void updateOverlayUiState((current) => ({
				...current,
				recordingBarPosition: toOverlayPosition(nextPosition),
			}))
				.then((state) => setPersistedBarPosition(state.recordingBarPosition))
				.catch(() => undefined);
		};

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerUp);
		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerUp);
		};
	}, [clampToViewport]);

	useEffect(() => {
		return () => {
			if (hoverTimeoutRef.current !== null) {
				window.clearTimeout(hoverTimeoutRef.current);
			}
		};
	}, []);

	const handleMouseEnter = useCallback(() => {
		if (isDragging) return;
		if (hoverTimeoutRef.current !== null) {
			window.clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		setIsExpanded(true);
	}, [isDragging]);

	const handleMouseLeave = useCallback(() => {
		if (isDragging) return;
		if (hoverTimeoutRef.current !== null) {
			window.clearTimeout(hoverTimeoutRef.current);
		}
		hoverTimeoutRef.current = window.setTimeout(() => {
			setIsExpanded(false);
			hoverTimeoutRef.current = null;
		}, 450);
	}, [isDragging]);

	const sendControl = useCallback(
		(type: BarControl) => {
			setBusy(true);
			sendServiceWorkerMessage({ target: "service-worker", type })
				.then((response) => {
					if (response.ok) applyResponse(response.status, response.plan);
				})
				.catch(() => undefined)
				.finally(() => setBusy(false));
		},
		[applyResponse],
	);

	const startRecording = useCallback(() => {
		setBusy(true);
		loadSettings()
			.then((settings) =>
				sendServiceWorkerMessage({
					target: "service-worker",
					type: "start-recording",
					mode: settings.capture.recordingMode,
				}),
			)
			.then((response) => {
				if (response.ok) applyResponse(response.status, response.plan);
			})
			.catch(() => undefined)
			.finally(() => setBusy(false));
	}, [applyResponse]);

	const dismissReadyBar = useCallback(() => {
		setReadyDismissed(true);
		void updateSharedUiState((current) => ({
			...current,
			readyBarDismissed: true,
			updatedAt: Date.now(),
		})).catch(() => undefined);
	}, []);

	const toggleDrawing = useCallback(() => setDrawing((value) => !value), []);
	const stopDrawing = useCallback(() => setDrawing(false), []);

	if (!visible) return null;

	if (status === null && countdownValue === null) {
		return (
			<>
				<div
					ref={barRef}
					className={classNames(
						"cap-extension-control-bar",
						isDragging && "is-dragging",
					)}
					role="toolbar"
					aria-label="Cap recording controls"
					style={{
						left: `${position?.x ?? EDGE_PADDING}px`,
						top: position ? `${position.y}px` : "50%",
						visibility: position ? "visible" : "hidden",
					}}
					onPointerDown={handlePointerDown}
				>
					<div className="cap-extension-control-bar-info">
						<img
							className="cap-extension-control-bar-logo"
							src={LOGO_URL}
							alt=""
							draggable={false}
						/>
						<div className="cap-extension-control-bar-text">
							<span className="cap-extension-control-bar-title">
								Ready to record
							</span>
							<span className="cap-extension-control-bar-subtitle">
								<span
									className="cap-extension-control-bar-dot is-ready"
									aria-hidden
								/>
								Cap
							</span>
						</div>
					</div>

					<div className="cap-extension-control-bar-divider" aria-hidden />

					<div className="cap-extension-control-bar-actions" data-controls>
						<button
							type="button"
							className={classNames(
								"cap-extension-control-bar-icon-button",
								blurActive && "is-active",
							)}
							aria-label="Blur content on page"
							title={blurActive ? "Exit blur mode" : "Blur content"}
							onClick={() => setBlurActive((prev) => !prev)}
						>
							<EyeOff size={17} aria-hidden />
						</button>

						{onToggleWebcam ? (
							<button
								type="button"
								className={classNames(
									"cap-extension-control-bar-icon-button",
									webcam?.enabled && "is-active",
								)}
								aria-label={webcam?.enabled ? "Camera on" : "Camera off"}
								title={webcam?.enabled ? "Camera enabled" : "Camera disabled"}
								onClick={onToggleWebcam}
							>
								{webcam?.enabled ? (
									<Video size={17} aria-hidden />
								) : (
									<VideoOff size={17} aria-hidden />
								)}
							</button>
						) : null}

						{onToggleMicrophone ? (
							<button
								type="button"
								className={classNames(
									"cap-extension-control-bar-icon-button",
									microphone?.enabled && "is-active",
								)}
								aria-label={microphone?.enabled ? "Mic unmuted" : "Mic muted"}
								title={microphone?.enabled ? "Mic unmuted" : "Mic muted"}
								onClick={onToggleMicrophone}
							>
								{microphone?.enabled ? (
									<Mic size={17} aria-hidden />
								) : (
									<MicOff size={17} aria-hidden />
								)}
							</button>
						) : null}

						<button
							type="button"
							className={classNames(
								"cap-extension-control-bar-icon-button",
								drawing && "is-active",
							)}
							aria-label="Draw on the page"
							aria-pressed={drawing}
							title="Draw on the page"
							onClick={toggleDrawing}
						>
							<Pencil size={17} aria-hidden />
						</button>

						<button
							type="button"
							className="cap-extension-control-bar-pill is-start"
							disabled={busy}
							onClick={startRecording}
						>
							<Play size={13} fill="currentColor" strokeWidth={0} aria-hidden />
							Start recording
						</button>

						<button
							type="button"
							className="cap-extension-control-bar-icon-button is-quiet"
							aria-label="Hide recording bar"
							title="Hide bar"
							onClick={dismissReadyBar}
						>
							<X size={18} aria-hidden />
						</button>
					</div>
				</div>
				<BlurOverlay active={blurActive} onDone={() => setBlurActive(false)} />
				<DrawingOverlay active={drawing} onClose={stopDrawing} />
			</>
		);
	}

	const isPaused = status?.phase === "paused";
	const maxMs =
		plan && !plan.isPro && plan.maxRecordingSeconds !== null
			? plan.maxRecordingSeconds * 1000
			: null;
	const durationMs = status ? currentDurationMs(status, now) : 0;
	const displayMs =
		maxMs !== null ? Math.max(0, maxMs - durationMs) : durationMs;
	const isWarning = maxMs !== null && displayMs <= WARNING_THRESHOLD_MS;
	const dockOpensUp = position === null || position.y > 340;
	const tooltipOnRight = position !== null && position.x < 120;

	return (
		<>
			<div
				ref={barRef}
				role="toolbar"
				aria-label="Active recording controls"
				className={classNames(
					"cap-extension-active-recording-container",
					isDragging && "is-dragging",
					isExpanded && "is-expanded",
					dockOpensUp ? "opens-up" : "opens-down",
					tooltipOnRight ? "tooltip-right" : "tooltip-left",
				)}
				style={{
					left: `${position?.x ?? EDGE_PADDING}px`,
					top: position ? `${position.y}px` : "50%",
					visibility: position ? "visible" : "hidden",
				}}
				onPointerDown={handlePointerDown}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
			>
				{isExpanded && status !== null ? (
					<div
						className="cap-extension-vertical-dock"
						role="toolbar"
						aria-label="Recording controls"
						data-controls
					>
						<button
							type="button"
							className="cap-extension-dock-btn is-stop"
							aria-label="End recording"
							data-tooltip="End recording"
							disabled={busy}
							onClick={() => sendControl("stop-recording")}
						>
							<Square
								size={14}
								fill="currentColor"
								strokeWidth={0}
								aria-hidden
							/>
						</button>

						<button
							type="button"
							className={classNames(
								"cap-extension-dock-btn is-pause",
								isPaused && "is-paused",
							)}
							aria-label={isPaused ? "Resume recording" : "Pause recording"}
							data-tooltip={isPaused ? "Resume" : "Pause"}
							disabled={busy}
							onClick={() =>
								sendControl(isPaused ? "resume-recording" : "pause-recording")
							}
						>
							{isPaused ? (
								<Play
									size={15}
									fill="currentColor"
									strokeWidth={0}
									aria-hidden
								/>
							) : (
								<Pause
									size={15}
									fill="currentColor"
									strokeWidth={0}
									aria-hidden
								/>
							)}
						</button>

						<button
							type="button"
							className={classNames(
								"cap-extension-dock-btn is-blur",
								blurActive && "is-active",
							)}
							aria-label={blurActive ? "Done blurring" : "Blur content"}
							data-tooltip={blurActive ? "Done blurring" : "Blur content"}
							onClick={() => {
								const next = !blurActive;
								setBlurActive(next);
								if (next && !isPaused) {
									sendControl("pause-recording");
								} else if (!next && isPaused) {
									sendControl("resume-recording");
								}
								setIsExpanded(false);
							}}
						>
							<EyeOff size={16} aria-hidden />
						</button>

						<button
							type="button"
							className={classNames(
								"cap-extension-dock-btn is-pen",
								drawing && "is-active",
							)}
							aria-label="Draw on page"
							data-tooltip="Draw / Pen"
							onClick={toggleDrawing}
						>
							<Pencil size={15} aria-hidden />
						</button>

						{onToggleWebcam ? (
							<button
								type="button"
								className={classNames(
									"cap-extension-dock-btn is-camera",
									webcam?.enabled && "is-active",
								)}
								aria-label={webcam?.enabled ? "Camera on" : "Camera off"}
								data-tooltip={
									webcam?.enabled
										? onUpdateWebcamShape
											? `Camera: ${webcam.shape} (Click to change shape)`
											: "Camera on"
										: "Camera off"
								}
								onClick={() => {
									if (webcam?.enabled && onUpdateWebcamShape) {
										onUpdateWebcamShape();
									} else if (onToggleWebcam) {
										onToggleWebcam();
									}
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									if (onToggleWebcam) onToggleWebcam();
								}}
							>
								{webcam?.enabled ? (
									<Video size={16} aria-hidden />
								) : (
									<VideoOff size={16} aria-hidden />
								)}
							</button>
						) : null}

						{onToggleMicrophone ? (
							<button
								type="button"
								className={classNames(
									"cap-extension-dock-btn is-mic",
									microphone?.enabled && "is-active",
									!microphone?.enabled && "is-muted",
								)}
								aria-label={
									microphone?.enabled ? "Mute microphone" : "Unmute microphone"
								}
								data-tooltip={microphone?.enabled ? "Mic unmuted" : "Mic muted"}
								onClick={onToggleMicrophone}
							>
								{microphone?.enabled ? (
									<Mic size={16} aria-hidden />
								) : (
									<MicOff size={16} aria-hidden />
								)}
							</button>
						) : null}

						<button
							type="button"
							className="cap-extension-dock-btn is-collapse"
							aria-label="Collapse menu"
							data-tooltip="Collapse"
							onClick={() => setIsExpanded(false)}
						>
							<ChevronDown size={16} aria-hidden />
						</button>
					</div>
				) : null}

				<button
					type="button"
					className={classNames(
						"cap-extension-recording-badge",
						countdownValue !== null && "is-counting",
						isPaused && "is-paused",
						isExpanded && "is-active",
					)}
					aria-label={
						isExpanded ? "Close recording menu" : "Open recording menu"
					}
					title={isExpanded ? "Close menu" : "Recording menu"}
					onClick={(e) => {
						e.stopPropagation();
						if (dragDistanceRef.current < 5) {
							setIsExpanded((c) => !c);
						}
					}}
				>
					<div className="cap-extension-recording-badge-icon-wrap">
						{countdownValue !== null ? (
							<div className="cap-extension-badge-countdown-ring">
								<span className="cap-extension-badge-countdown-number">
									{countdownValue}
								</span>
							</div>
						) : (
							<>
								<img
									className="cap-extension-recording-badge-logo"
									src={LOGO_URL}
									alt=""
									draggable={false}
								/>
								<span
									className={classNames(
										"cap-extension-control-bar-dot",
										isPaused ? "is-paused" : "is-recording",
									)}
									aria-hidden
								/>
							</>
						)}
					</div>

					{countdownValue === null && status ? (
						<span
							className={classNames(
								"cap-extension-recording-badge-time",
								isWarning && "is-warning",
							)}
						>
							{formatDuration(displayMs)}
						</span>
					) : null}
				</button>
			</div>

			<BlurOverlay
				active={blurActive}
				onDone={() => {
					setBlurActive(false);
					if (status?.phase === "paused") {
						sendControl("resume-recording");
					}
				}}
			/>
			<DrawingOverlay active={drawing} onClose={stopDrawing} />
		</>
	);
}
