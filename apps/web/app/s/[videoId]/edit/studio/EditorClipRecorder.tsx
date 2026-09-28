"use client";

import clsx from "clsx";
import {
	CameraIcon,
	LoaderCircleIcon,
	MicIcon,
	MonitorIcon,
	Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	RecordingBar,
	StartRecordingButton,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder-dock";
import {
	formatClock,
	LiveVideo,
	SourceRow,
	Switch,
	useMicLevel,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder-parts";
import "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recorder.css";
import { acquireDisplayStream } from "@cap/recorder-core/capture-streams";
import {
	capturesThisTab,
	identifyThisTab,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/capture-handle";
import {
	type EditorClipCapture,
	type EditorClipCaptureSession,
	startEditorClipCapture,
} from "@/lib/editor-clip-recorder";
import type { ClipRecorderContext } from "./clip-recorder-context";

type Phase =
	| "idle"
	| "starting"
	| "recording"
	| "paused"
	| "uploading"
	| "error";

export function EditorClipRecorder(props: {
	context: ClipRecorderContext | null;
	onCaptured: (clip: EditorClipCapture) => Promise<void>;
	onClose: (imported: boolean) => void;
	/** True while a clip is being recorded or added, when leaving would lose it. */
	onBusyChange?: (busy: boolean) => void;
}) {
	const titleId = useId();
	const [cameraEnabled, setCameraEnabled] = useState(true);
	const [micEnabled, setMicEnabled] = useState(true);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [cameraPreview, setCameraPreview] = useState<MediaStream | null>(null);
	const [screen, setScreen] = useState<MediaStream | null>(null);
	const [sharing, setSharing] = useState(false);
	const screenRef = useRef<MediaStream | null>(null);
	const [recordingStream, setRecordingStream] = useState<MediaStream | null>(
		null,
	);
	const [captured, setCaptured] = useState<EditorClipCapture | null>(null);
	const [capturedCanImport, setCapturedCanImport] = useState(false);
	const [downloadUrls, setDownloadUrls] = useState<{
		display: string;
		camera: string | null;
	} | null>(null);
	const sessionRef = useRef<EditorClipCaptureSession | null>(null);
	const disposedRef = useRef(false);
	const captureAbortRef = useRef<AbortController | null>(null);
	const stopRef = useRef<() => Promise<void>>(async () => undefined);
	const stoppingRef = useRef(false);
	const startedAtRef = useRef(0);
	const pausedAtRef = useRef<number | null>(null);
	const pausedTotalRef = useRef(0);

	const idle = phase === "idle" || (phase === "error" && !captured);
	const live = phase === "recording" || phase === "paused";
	const micLevel = useMicLevel("default", micEnabled && (idle || live));

	const onBusyChange = props.onBusyChange;
	useEffect(() => {
		onBusyChange?.(phase !== "idle" && phase !== "error");
	}, [phase, onBusyChange]);
	useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

	// A camera preview while setting up; the capture opens its own once it starts.
	useEffect(() => {
		if (!cameraEnabled || !idle) {
			setCameraPreview(null);
			return;
		}
		let stream: MediaStream | null = null;
		let disposed = false;
		void navigator.mediaDevices
			?.getUserMedia({ video: { height: { ideal: 720 } } })
			.then((next) => {
				if (disposed) {
					for (const track of next.getTracks()) track.stop();
					return;
				}
				stream = next;
				setCameraPreview(next);
			})
			.catch(() => setCameraPreview(null));
		return () => {
			disposed = true;
			if (stream) for (const track of stream.getTracks()) track.stop();
		};
	}, [cameraEnabled, idle]);

	useEffect(() => {
		if (!live) return;
		const timer = window.setInterval(() => {
			const now = pausedAtRef.current ?? performance.now();
			setElapsedMs(
				Math.max(0, now - startedAtRef.current - pausedTotalRef.current),
			);
		}, 200);
		return () => window.clearInterval(timer);
	}, [live]);

	useEffect(() => {
		if (!captured) {
			setDownloadUrls(null);
			return;
		}
		const display = URL.createObjectURL(captured.display);
		const camera = captured.camera
			? URL.createObjectURL(captured.camera)
			: null;
		setDownloadUrls({ display, camera });
		return () => {
			URL.revokeObjectURL(display);
			if (camera) URL.revokeObjectURL(camera);
		};
	}, [captured]);

	useEffect(() => {
		disposedRef.current = false;
		captureAbortRef.current = new AbortController();
		identifyThisTab();
		return () => {
			disposedRef.current = true;
			for (const track of screenRef.current?.getTracks() ?? []) track.stop();
			captureAbortRef.current?.abort();
			captureAbortRef.current = null;
			const session = sessionRef.current;
			sessionRef.current = null;
			void session?.stop().catch(() => undefined);
		};
	}, []);

	const importCapture = useCallback(
		async (clip: EditorClipCapture) => {
			setPhase("uploading");
			setError(null);
			try {
				await props.onCaptured(clip);
				if (disposedRef.current) return;
				await sessionRef.current?.release().catch(() => undefined);
				if (disposedRef.current) return;
				sessionRef.current = null;
				props.onClose(true);
			} catch (cause) {
				if (disposedRef.current) return;
				setError(
					cause instanceof Error ? cause.message : "Could not add the clip",
				);
				setCapturedCanImport(true);
				setPhase("error");
			}
		},
		[props],
	);

	const handleStop = useCallback(async () => {
		const session = sessionRef.current;
		if (stoppingRef.current || !session) return;
		stoppingRef.current = true;
		setPhase("uploading");
		try {
			const clip = await session.stop();
			if (disposedRef.current) return;
			setRecordingStream(null);
			setCaptured(clip);
			setCapturedCanImport(true);
			await importCapture(clip);
		} catch (cause) {
			if (disposedRef.current) return;
			setRecordingStream(null);
			const recovered = await session.recover().catch(() => null);
			if (disposedRef.current) return;
			setCaptured(recovered);
			setCapturedCanImport(false);
			setError(
				cause instanceof Error ? cause.message : "Could not finish the clip",
			);
			setPhase("error");
		} finally {
			stoppingRef.current = false;
		}
	}, [importCapture]);
	stopRef.current = handleStop;

	const updateScreen = (stream: MediaStream | null) => {
		screenRef.current = stream;
		setScreen(stream);
	};

	const shareScreen = async () => {
		if (sharing) return null;
		setSharing(true);
		setError(null);
		try {
			const stream = await acquireDisplayStream({ systemAudioEnabled });
			if (disposedRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return null;
			}
			for (const track of screenRef.current?.getTracks() ?? []) track.stop();
			stream.getVideoTracks()[0]?.addEventListener("ended", () => {
				if (screenRef.current === stream) updateScreen(null);
			});
			updateScreen(stream);
			return stream;
		} catch {
			return null;
		} finally {
			setSharing(false);
		}
	};

	const handleStart = async () => {
		if (disposedRef.current || !idle) return;
		const displayStream = screenRef.current ?? (await shareScreen());
		if (!displayStream || disposedRef.current) return;
		if (sessionRef.current) {
			await sessionRef.current.discard().catch(() => undefined);
			if (disposedRef.current) return;
			sessionRef.current = null;
		}
		setCaptured(null);
		setCapturedCanImport(false);
		setError(null);
		setPhase("starting");
		try {
			updateScreen(null);
			const session = await startEditorClipCapture({
				displayStream,
				cameraEnabled,
				micEnabled,
				systemAudioEnabled,
				signal: captureAbortRef.current?.signal,
				onDisplayEnded: () => void stopRef.current(),
				onError: (cause) => {
					if (disposedRef.current) return;
					setError(cause.message);
					void stopRef.current();
				},
			});
			if (disposedRef.current) {
				await session.stop().catch(() => undefined);
				return;
			}
			sessionRef.current = session;
			setRecordingStream(session.cameraPreviewStream);
			startedAtRef.current = performance.now();
			pausedAtRef.current = null;
			pausedTotalRef.current = 0;
			setElapsedMs(0);
			setPhase("recording");
		} catch (cause) {
			if (disposedRef.current) return;
			setError(
				cause instanceof Error ? cause.message : "Could not start recording",
			);
			setPhase("error");
		}
	};

	const handlePause = () => {
		if (phase !== "recording") return;
		sessionRef.current?.pause();
		pausedAtRef.current = performance.now();
		setPhase("paused");
	};

	const handleResume = () => {
		if (phase !== "paused") return;
		sessionRef.current?.resume();
		pausedTotalRef.current += performance.now() - (pausedAtRef.current ?? 0);
		pausedAtRef.current = null;
		setPhase("recording");
	};

	const handleDiscard = async () => {
		if (phase === "uploading" || phase === "starting") return;
		await sessionRef.current?.discard();
		if (disposedRef.current) return;
		sessionRef.current = null;
		props.onClose(false);
	};

	const context = props.context;
	const clips = context?.clips ?? [];
	const insertAt = context?.insertAt ?? clips.length;
	const before = clips[insertAt - 1];
	const after = clips[insertAt];
	const landsAt = clips
		.slice(0, insertAt)
		.reduce((sum, clip) => sum + clip.duration, 0);
	const placement = !context
		? "Goes on the end of your video"
		: before
			? `Clip ${insertAt + 1} · after ${before.name}, at ${formatClock(landsAt * 1000)}`
			: after
				? `Clip 1 · before ${after.name}`
				: "Your first clip";
	const cameraStream = live ? recordingStream : cameraPreview;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			className="cap-rec absolute inset-0 z-[100] flex flex-col gap-2 overflow-y-auto bg-[var(--rec-window)] p-2 text-[var(--rec-text-1)]"
		>
			<div className="flex min-h-[360px] flex-1 gap-2 max-[900px]:flex-col">
				<section className="rec-card flex min-w-0 flex-1 flex-col overflow-hidden">
					<header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--rec-line)] px-4">
						<div className="flex min-w-0 flex-col">
							<h2
								id={titleId}
								className="text-[14px] font-medium leading-5 tracking-[-0.005em]"
							>
								Record a new clip
							</h2>
							<p className="truncate text-[12px] leading-4 text-[var(--rec-text-2)]">
								{placement}
							</p>
						</div>
						{phase !== "starting" && phase !== "uploading" && (
							<button
								type="button"
								className="rec-btn is-ghost shrink-0"
								onClick={() => void handleDiscard()}
							>
								{live ? "Discard clip" : "Back to editor"}
							</button>
						)}
					</header>
					<div className="relative flex min-h-0 flex-1 items-center justify-center p-4 [container-type:size]">
						<div className="relative aspect-video w-[min(100cqw,100cqh*16/9)] overflow-hidden rounded-[10px] bg-[var(--rec-media)]">
							{screen && !live ? (
								<ScreenPreview stream={screen} />
							) : (
								context?.boundaryFrame && (
									<img
										src={context.boundaryFrame}
										alt=""
										className={clsx(
											"absolute inset-0 size-full object-cover transition-opacity duration-500",
											live ? "opacity-[0.12]" : "opacity-45",
										)}
									/>
								)
							)}
							{!live && context?.boundaryFrame && (before || after) && (
								<div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/60 p-1 pr-2.5 text-[12px] font-medium text-white backdrop-blur-sm">
									{screen && (
										<img
											src={context.boundaryFrame}
											alt=""
											className="h-8 rounded-[5px] object-cover"
										/>
									)}
									{before
										? `Follows the end of ${before.name}`
										: `Leads into ${after?.name}`}
								</div>
							)}
							{idle && !screen && (
								<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white">
									<p className="text-[15px] font-medium">
										Share the screen you want to record
									</p>
									<p className="max-w-sm text-[13px] text-white/70">
										Pick a screen, window or tab. You'll see it here before you
										start.
									</p>
									<button
										type="button"
										disabled={sharing}
										onClick={() => void shareScreen()}
										className="rec-btn is-accent mt-1"
									>
										<MonitorIcon className="size-4" aria-hidden />
										{sharing ? "Choosing…" : "Share screen"}
									</button>
								</div>
							)}
							<StageMessage
								phase={phase}
								elapsedMs={elapsedMs}
								clipNumber={insertAt + 1}
							/>
							{cameraEnabled && cameraStream && (
								<div className="absolute bottom-[5%] right-[3%] aspect-square w-[22%] overflow-hidden rounded-[30%] bg-black shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)] ring-1 ring-white/15">
									<LiveVideo
										stream={cameraStream}
										className="size-full object-cover"
									/>
								</div>
							)}
						</div>
					</div>
					<footer className="flex h-16 shrink-0 items-center justify-center border-t border-[var(--rec-line)] px-4">
						{idle ? (
							<StartRecordingButton
								busy={sharing}
								detail={
									screen
										? `Adds clip ${insertAt + 1} to this video`
										: "Shares your screen, then records"
								}
								onClick={() => void handleStart()}
							/>
						) : live ? (
							<RecordingBar
								time={formatClock(elapsedMs)}
								paused={phase === "paused"}
								restarting={false}
								onStop={() => void handleStop()}
								onPauseToggle={phase === "paused" ? handleResume : handlePause}
							/>
						) : phase === "error" && captured && capturedCanImport ? (
							<button
								type="button"
								className="rec-btn is-accent"
								onClick={() => void importCapture(captured)}
							>
								Try adding it again
							</button>
						) : null}
					</footer>
				</section>
				<aside className="rec-card flex w-[20rem] shrink-0 flex-col gap-3 p-2 max-[900px]:w-full">
					<p className="px-2 pt-1.5 text-[13px] font-medium">Sources</p>
					<ul className="flex flex-col gap-0.5">
						<SourceRow
							kind="screen"
							icon={MonitorIcon}
							label="Screen"
							on={!!screen || live}
							detail={
								live
									? "Recording"
									: screen
										? `Sharing ${sharedSurface(screen)}`
										: "Not shared yet"
							}
							actions={
								idle && (
									<button
										type="button"
										disabled={sharing}
										onClick={() => void shareScreen()}
										className="rec-btn is-ghost !h-7 !px-2 text-[12px]"
									>
										{screen ? "Change" : "Share"}
									</button>
								)
							}
						/>
						<SourceRow
							kind="camera"
							icon={CameraIcon}
							label="Camera"
							on={cameraEnabled}
							detail={cameraEnabled ? "On its own track" : "Off"}
							actions={
								<Switch
									label="Camera"
									on={cameraEnabled}
									disabled={!idle}
									onChange={setCameraEnabled}
								/>
							}
						/>
						<SourceRow
							kind="mic"
							icon={MicIcon}
							label="Microphone"
							on={micEnabled}
							level={micLevel}
							detail={micEnabled ? "Your voice" : "Muted"}
							actions={
								<Switch
									label="Microphone"
									on={micEnabled}
									disabled={!idle}
									onChange={setMicEnabled}
								/>
							}
						/>
						<SourceRow
							kind="system"
							icon={Volume2Icon}
							label="Screen audio"
							on={systemAudioEnabled}
							detail={
								screen
									? screen.getAudioTracks().length > 0
										? "Included"
										: "Not shared with the screen"
									: systemAudioEnabled
										? "Turn on audio in the share popup"
										: "Off"
							}
							actions={
								<Switch
									label="Screen audio"
									on={systemAudioEnabled}
									disabled={!idle || !!screen}
									onChange={setSystemAudioEnabled}
								/>
							}
						/>
					</ul>
					{error && (
						<p
							role="alert"
							className="mx-1 rounded-lg bg-[color-mix(in_srgb,var(--rec-red)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--rec-red)]"
						>
							{error}
						</p>
					)}
					{captured && downloadUrls && phase === "error" && (
						<div className="flex flex-wrap gap-x-4 gap-y-1 px-2 text-[13px] text-[var(--rec-accent)]">
							<a href={downloadUrls.display} download={captured.display.name}>
								Download screen clip
							</a>
							{captured.camera && downloadUrls.camera && (
								<a href={downloadUrls.camera} download={captured.camera.name}>
									Download camera clip
								</a>
							)}
						</div>
					)}
					<p className="mt-auto px-2 pb-1.5 text-[12px] leading-relaxed text-[var(--rec-text-2)]">
						When you stop, the clip drops into your video with the same style as
						the rest of it. Trim, move or re-record it from the editor.
					</p>
				</aside>
			</div>
			<ProjectTimeline
				clips={clips}
				insertAt={insertAt}
				live={live}
				elapsedMs={elapsedMs}
			/>
		</div>
	);
}

function sharedSurface(stream: MediaStream) {
	const surface = (
		stream.getVideoTracks()[0]?.getSettings() as
			| (MediaTrackSettings & { displaySurface?: string })
			| undefined
	)?.displaySurface;
	return surface === "monitor"
		? "your screen"
		: surface === "window"
			? "a window"
			: "a tab";
}

function ScreenPreview(props: { stream: MediaStream }) {
	const mirrorsItself = capturesThisTab(props.stream);
	return (
		<>
			<LiveVideo
				stream={props.stream}
				mirror={false}
				className={clsx(
					"absolute inset-0 size-full object-contain",
					mirrorsItself && "opacity-[0.07]",
				)}
			/>
			{mirrorsItself && (
				<p className="absolute inset-x-0 bottom-4 text-center text-[12px] text-white/70">
					Preview dimmed so it doesn't repeat inside itself
				</p>
			)}
		</>
	);
}

function StageMessage(props: {
	phase: Phase;
	elapsedMs: number;
	clipNumber: number;
}) {
	if (props.phase === "starting") {
		return (
			<div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-white">
				<p className="text-[15px] font-medium">Choose what to share</p>
				<p className="text-[13px] text-white/70">
					Pick a screen, window or tab in your browser's popup
				</p>
			</div>
		);
	}
	if (props.phase === "recording" || props.phase === "paused") {
		return (
			<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
				<span className="flex items-center gap-2 text-[13px] font-medium text-white/80">
					<span
						className={clsx(
							"size-2 rounded-full",
							props.phase === "paused"
								? "bg-amber-400"
								: "animate-pulse bg-red-500",
						)}
					/>
					{props.phase === "paused"
						? "Paused"
						: `Recording clip ${props.clipNumber}`}
				</span>
				<span className="text-[44px] font-medium tabular-nums tracking-tight">
					{formatClock(props.elapsedMs)}
				</span>
				<span className="text-[13px] text-white/60">
					Switch to what you're sharing. This tab keeps recording.
				</span>
			</div>
		);
	}
	if (props.phase === "uploading") {
		return (
			<div className="absolute inset-0 flex items-center justify-center gap-2 text-[14px] font-medium text-white">
				<LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
				Adding the clip to your video
			</div>
		);
	}
	return null;
}

function ProjectTimeline(props: {
	clips: ClipRecorderContext["clips"];
	insertAt: number;
	live: boolean;
	elapsedMs: number;
}) {
	const total = props.clips.reduce((sum, clip) => sum + clip.duration, 0);
	const newSeconds = props.elapsedMs / 1000;
	const slot = (
		<div
			key="new-clip"
			className={clsx(
				"relative flex h-full min-w-[88px] shrink-0 flex-col justify-end overflow-hidden rounded-md px-2 pb-1.5 text-[11px] font-medium transition-[flex-grow] duration-300",
				props.live
					? "bg-[color-mix(in_srgb,var(--rec-red)_16%,transparent)] text-[var(--rec-red)] shadow-[inset_0_0_0_1.5px_var(--rec-red)]"
					: "text-[var(--rec-accent)] shadow-[inset_0_0_0_1.5px_var(--rec-accent)] [background:repeating-linear-gradient(135deg,color-mix(in_srgb,var(--rec-accent)_10%,transparent)_0_6px,transparent_6px_12px)]",
			)}
			style={{ flexGrow: Math.max(newSeconds, total * 0.08, 1) }}
		>
			<span className="truncate">
				{props.live ? formatClock(props.elapsedMs) : "New clip"}
			</span>
		</div>
	);
	const blocks = props.clips.map((clip, index) => (
		<div
			// biome-ignore lint/suspicious/noArrayIndexKey: clips have no ids and never reorder here
			key={index}
			className="relative flex h-full min-w-[56px] shrink-0 flex-col justify-end overflow-hidden rounded-md bg-[var(--rec-card-2)] shadow-[inset_0_0_0_1px_var(--rec-line)]"
			style={{ flexGrow: Math.max(clip.duration, 0.1) }}
		>
			{clip.thumbnail && (
				<img
					src={clip.thumbnail}
					alt=""
					className="absolute inset-0 size-full object-cover opacity-80"
				/>
			)}
			<span className="relative flex items-end justify-between gap-1 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-3 text-[11px] font-medium text-white">
				<span className="truncate">{clip.name}</span>
				<span className="shrink-0 tabular-nums text-white/75">
					{formatClock(clip.duration * 1000)}
				</span>
			</span>
		</div>
	));
	blocks.splice(props.insertAt, 0, slot);

	return (
		<section className="rec-card flex h-[112px] shrink-0 flex-col gap-2 px-4 py-3">
			<div className="flex items-baseline justify-between gap-3 text-[12px]">
				<span className="text-[13px] font-medium">Your video</span>
				<span className="tabular-nums text-[var(--rec-text-2)]">
					{formatClock(total * 1000)}
					{props.live && newSeconds > 0
						? ` + ${formatClock(props.elapsedMs)} new`
						: props.clips.length > 0
							? ` · ${props.clips.length} ${props.clips.length === 1 ? "clip" : "clips"}`
							: ""}
				</span>
			</div>
			<div className="flex min-h-0 flex-1 gap-1">{blocks}</div>
		</section>
	);
}
