import { GripVertical, Pause, Pencil, Play, Square, X } from "lucide-react";
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
	OverlayPosition,
	RecordingPlan,
	RecordingStatus,
	SharedRecordingState,
} from "../shared/types";
import { DrawingOverlay } from "./drawing-overlay";

const EDGE_PADDING = 16;
const BOTTOM_OFFSET = 28;
// Live updates arrive via status broadcasts and the session-storage mirror;
// this poll only reconciles drift, so it can be slow instead of hammering the
// service worker (and through it the offscreen document) from every tab.
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

// The timer derives from wall-clock deltas against the shared status, so as
// long as every tab holds the same status object their clocks read the same.
const currentDurationMs = (status: BarStatus, now: number) =>
	status.phase === "recording"
		? status.durationMs + Math.max(0, now - status.updatedAt)
		: status.durationMs;

export function RecordingBarOverlay({
	recorderPanelOpen,
}: RecordingBarOverlayProps) {
	const [status, setStatus] = useState<BarStatus | null>(null);
	const [plan, setPlan] = useState<RecordingPlan | null>(null);
	const [signedIn, setSignedIn] = useState(false);
	const [readyDismissed, setReadyDismissed] = useState(false);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [persistedBarPosition, setPersistedBarPosition] =
		useState<OverlayPosition | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [drawing, setDrawing] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const dragOffsetRef = useRef({ x: 0, y: 0 });
	const barRef = useRef<HTMLDivElement>(null);
	const planRef = useRef<RecordingPlan | null>(null);
	const positionRef = useRef<{ x: number; y: number } | null>(null);
	const positionModeRef = useRef<"active" | "ready" | null>(null);
	const recorderPanelOpenRef = useRef(false);

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

	// chrome.storage.session is the cross-tab source of truth for both the
	// recording state and the shared UI flags; the storage change events reach
	// every tab (including backgrounded ones), which keeps each bar in lockstep
	// without per-tab polling round-trips.
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
			// Recompute the clock immediately so the first painted frame after a
			// tab switch already shows the right time, then reconcile from the
			// session-storage mirror: reading storage does not wake the service
			// worker, unlike a get-recording-status round trip, and the slow
			// poll below still corrects any drift while the bar is active.
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
		const handleMessage = (message: unknown) => {
			if (isRecordingStatusBroadcast(message)) {
				applyResponse(message.status);
				if (!planRef.current) refresh();
				return false;
			}
			if (!isOverlayMessage(message)) return false;
			refresh();
			return false;
		};
		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [applyResponse, refresh]);

	const active = status !== null;
	// The "Ready to record" bar only makes sense once the user can actually
	// start a recording, which requires being signed in.
	const ready = signedIn && !active && recorderPanelOpen && !readyDismissed;
	const visible = active || ready;

	// Drawing is reachable only from a visible bar, so once the bar hides
	// (recording stopped and the ready bar dismissed) tear the canvas down too
	// rather than leaving an invisible surface armed to swallow page clicks.
	useEffect(() => {
		if (!visible) setDrawing(false);
	}, [visible]);

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const interval = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(interval);
	}, [active]);

	useEffect(() => {
		if (!active) return;
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") refresh();
		}, POLL_INTERVAL_MS);
		return () => window.clearInterval(interval);
	}, [active, refresh]);

	const clampToViewport = useCallback((value: { x: number; y: number }) => {
		const rect = barRef.current?.getBoundingClientRect();
		const width = rect?.width ?? 360;
		const height = rect?.height ?? 64;
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
	}, []);

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
								y: (window.innerHeight - rect.height) / 2,
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
			event.preventDefault();
			event.stopPropagation();
			// Capture the pointer so the drag survives the cursor crossing
			// iframes (for example the camera preview) on the page.
			event.currentTarget.setPointerCapture(event.pointerId);
			setIsDragging(true);
			dragOffsetRef.current = {
				x: event.clientX - (position?.x ?? EDGE_PADDING),
				y: event.clientY - (position?.y ?? EDGE_PADDING),
			};
		},
		[position],
	);

	useEffect(() => {
		if (!isDragging) return;
		const handlePointerMove = (event: PointerEvent) => {
			setPosition(
				clampToViewport({
					x: event.clientX - dragOffsetRef.current.x,
					y: event.clientY - dragOffsetRef.current.y,
				}),
			);
		};
		const handlePointerUp = () => {
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
	}, [clampToViewport, isDragging]);

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

	if (status === null) {
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
							className="cap-extension-control-bar-pill is-start"
							disabled={busy}
							onClick={startRecording}
						>
							<Play size={14} fill="currentColor" strokeWidth={0} aria-hidden />
							Start recording
						</button>
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
							<Pencil size={18} aria-hidden />
						</button>
						<button
							type="button"
							className="cap-extension-control-bar-icon-button is-quiet"
							aria-label="Hide recording bar"
							title="Hide bar"
							onClick={dismissReadyBar}
						>
							<X size={20} aria-hidden />
						</button>
					</div>
				</div>
				<DrawingOverlay active={drawing} onClose={stopDrawing} />
			</>
		);
	}

	const isPaused = status.phase === "paused";
	const maxMs =
		plan && !plan.isPro && plan.maxRecordingSeconds !== null
			? plan.maxRecordingSeconds * 1000
			: null;
	const durationMs = currentDurationMs(status, now);
	const displayMs =
		maxMs !== null ? Math.max(0, maxMs - durationMs) : durationMs;
	const isWarning = maxMs !== null && displayMs <= WARNING_THRESHOLD_MS;
	const actionsOpenLeft =
		position !== null && position.x > window.innerWidth / 2;

	return (
		<>
			<div
				ref={barRef}
				className={classNames(
					"cap-extension-recording-rail",
					isDragging && "is-dragging",
					actionsOpenLeft && "opens-left",
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
				<div
					className={classNames(
						"cap-extension-recording-rail-timer",
						isWarning && "is-warning",
					)}
					data-drag-handle
					title="Drag recording controls"
				>
					<GripVertical
						className="cap-extension-recording-rail-grip"
						size={14}
						aria-hidden
					/>
					<span
						className={classNames(
							"cap-extension-control-bar-dot",
							isPaused ? "is-paused" : "is-recording",
						)}
						aria-hidden
					/>
					<span
						className="cap-extension-recording-rail-time"
						data-recording-time
					>
						{formatDuration(displayMs)}
					</span>
				</div>
				<button
					type="button"
					className="cap-extension-control-bar-pill is-stop is-compact"
					aria-label="Stop recording"
					title="Stop recording"
					disabled={busy}
					data-controls
					onClick={() => sendControl("stop-recording")}
				>
					<Square size={12} fill="currentColor" strokeWidth={0} aria-hidden />
				</button>
				<div
					className="cap-extension-recording-rail-actions"
					data-controls
					data-recording-actions
				>
					<button
						type="button"
						className="cap-extension-control-bar-icon-button is-compact"
						aria-label={isPaused ? "Resume recording" : "Pause recording"}
						title={isPaused ? "Resume" : "Pause"}
						disabled={busy}
						data-recording-pause
						onClick={() =>
							sendControl(isPaused ? "resume-recording" : "pause-recording")
						}
					>
						{isPaused ? (
							<Play size={16} fill="currentColor" strokeWidth={0} aria-hidden />
						) : (
							<Pause
								size={16}
								fill="currentColor"
								strokeWidth={0}
								aria-hidden
							/>
						)}
					</button>
					<button
						type="button"
						className={classNames(
							"cap-extension-control-bar-icon-button is-compact",
							drawing && "is-active",
						)}
						aria-label="Draw on the page"
						aria-pressed={drawing}
						title="Draw on the page"
						onClick={toggleDrawing}
					>
						<Pencil size={16} aria-hidden />
					</button>
				</div>
			</div>
			<DrawingOverlay active={drawing} onClose={stopDrawing} />
		</>
	);
}
