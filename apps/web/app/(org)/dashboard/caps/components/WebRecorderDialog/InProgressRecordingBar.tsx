"use client";
import clsx from "clsx";
import {
	Mic,
	MicOff,
	MoreVertical,
	PauseCircle,
	PlayCircle,
	RotateCcw,
	StopCircle,
} from "lucide-react";
import {
	type ComponentProps,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { ChunkUploadState, RecorderPhase } from "./web-recorder-types";

const phaseMessages: Partial<Record<RecorderPhase, string>> = {
	recording: "Recording",
	paused: "Paused",
	creating: "Finishing up",
	converting: "Converting",
	uploading: "Uploading",
};

const clamp = (value: number, min: number, max: number) => {
	if (Number.isNaN(value)) return min;
	if (max < min) return min;
	return Math.min(Math.max(value, min), max);
};

const formatDuration = (durationMs: number) => {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface InProgressRecordingBarProps {
	phase: RecorderPhase;
	durationMs: number;
	hasAudioTrack: boolean;
	chunkUploads: ChunkUploadState[];
	onStop: () => void | Promise<void>;
	onPause?: () => void | Promise<void>;
	onResume?: () => void | Promise<void>;
	onRestart?: () => void | Promise<void>;
	isRestarting?: boolean;
}

const DRAG_PADDING = 12;

export const InProgressRecordingBar = ({
	phase,
	durationMs,
	hasAudioTrack,
	chunkUploads,
	onStop,
	onPause,
	onResume,
	onRestart,
	isRestarting = false,
}: InProgressRecordingBarProps) => {
	const [mounted, setMounted] = useState(false);
	const [position, setPosition] = useState({ x: 0, y: 24 });
	const [isDragging, setIsDragging] = useState(false);
	const dragOffsetRef = useRef({ x: 0, y: 0 });
	const containerRef = useRef<HTMLDivElement>(null);
	const initializedPositionRef = useRef(false);

	useEffect(() => {
		setMounted(true);
		return () => setMounted(false);
	}, []);

	useEffect(() => {
		if (!mounted || initializedPositionRef.current) return;
		if (typeof window === "undefined") return;

		const raf = window.requestAnimationFrame(() => {
			const rect = containerRef.current?.getBoundingClientRect();
			if (!rect) return;

			const maxX = window.innerWidth - rect.width - DRAG_PADDING;
			initializedPositionRef.current = true;
			setPosition({
				x: clamp((window.innerWidth - rect.width) / 2, DRAG_PADDING, maxX),
				y: DRAG_PADDING * 2,
			});
		});

		return () => {
			if (typeof window !== "undefined") {
				window.cancelAnimationFrame(raf);
			}
		};
	}, [mounted]);

	useEffect(() => {
		if (typeof window === "undefined") return;

		const handleResize = () => {
			const rect = containerRef.current?.getBoundingClientRect();
			if (!rect) return;

			setPosition((prev) => {
				const maxX = window.innerWidth - rect.width - DRAG_PADDING;
				const maxY = window.innerHeight - rect.height - DRAG_PADDING;
				return {
					x: clamp(prev.x, DRAG_PADDING, maxX),
					y: clamp(prev.y, DRAG_PADDING, maxY),
				};
			});
		};

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	const handlePointerDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			if (
				(event.target as HTMLElement)?.closest("[data-no-drag]") ||
				event.button !== 0
			) {
				return;
			}

			event.preventDefault();
			setIsDragging(true);
			dragOffsetRef.current = {
				x: event.clientX - position.x,
				y: event.clientY - position.y,
			};
		},
		[position],
	);

	useEffect(() => {
		if (!isDragging || typeof window === "undefined") {
			return undefined;
		}

		const handleMouseMove = (event: MouseEvent) => {
			const rect = containerRef.current?.getBoundingClientRect();
			const width = rect?.width ?? 360;
			const height = rect?.height ?? 64;
			const maxX = window.innerWidth - width - DRAG_PADDING;
			const maxY = window.innerHeight - height - DRAG_PADDING;

			setPosition({
				x: clamp(event.clientX - dragOffsetRef.current.x, DRAG_PADDING, maxX),
				y: clamp(event.clientY - dragOffsetRef.current.y, DRAG_PADDING, maxY),
			});
		};

		const handleMouseUp = () => {
			setIsDragging(false);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging]);

	if (!mounted || typeof document === "undefined") {
		return null;
	}

	const isPaused = phase === "paused";
	const canStop = phase === "recording" || isPaused;
	const showTimer = phase === "recording" || isPaused;
	const statusText = showTimer
		? formatDuration(durationMs)
		: (phaseMessages[phase] ?? "Processing");

	const handleStop = () => {
		Promise.resolve(onStop()).catch((error) => {
			console.error("Failed to stop recording", error);
		});
	};

	const handlePauseToggle = () => {
		if (isPaused) {
			if (!onResume) return;
			Promise.resolve(onResume()).catch((error) => {
				console.error("Failed to resume recording", error);
			});
			return;
		}

		if (phase === "recording" && onPause) {
			Promise.resolve(onPause()).catch((error) => {
				console.error("Failed to pause recording", error);
			});
		}
	};

	const canTogglePause =
		(phase === "recording" && Boolean(onPause)) ||
		(isPaused && Boolean(onResume));
	const canRestart =
		Boolean(onRestart) && !isRestarting && (phase === "recording" || isPaused);

	const handleRestart = () => {
		if (!onRestart || !canRestart) return;
		const result = onRestart();
		if (result instanceof Promise) {
			void result.catch(() => {
				/* ignore */
			});
		}
	};

	return createPortal(
		<div
			ref={containerRef}
			className={clsx(
				"fixed z-[650] pointer-events-auto animate-in fade-in",
				isDragging ? "cursor-grabbing" : "cursor-move",
			)}
			style={{ left: `${position.x}px`, top: `${position.y}px` }}
			onMouseDown={handlePointerDown}
			role="status"
			aria-live="polite"
		>
			<div className="flex flex-row items-stretch rounded-[0.9rem] border border-gray-5 bg-gray-1 text-gray-12 shadow-[0_16px_60px_rgba(0,0,0,0.35)] min-w-[360px]">
				<div className="flex flex-row justify-between flex-1 gap-3 p-[0.25rem]">
					<button
						type="button"
						data-no-drag
						onClick={handleStop}
						disabled={!canStop}
						className="py-[0.25rem] px-[0.5rem] text-red-300 gap-[0.35rem] flex flex-row items-center rounded-lg transition-opacity disabled:opacity-60"
					>
						<StopCircle className="size-5" />
						<span className="font-[500] text-[0.875rem] tabular-nums">
							{statusText}
						</span>
					</button>

					<div className="flex gap-3 items-center" data-no-drag>
						<InlineChunkProgress chunkUploads={chunkUploads} />
						<div className="flex relative justify-center items-center w-8 h-8">
							{hasAudioTrack ? (
								<>
									<Mic className="size-5 text-gray-12" />
									<div className="absolute bottom-1 left-1 right-1 h-0.5 bg-gray-10 overflow-hidden rounded-full">
										<div
											className="absolute inset-0 bg-blue-9 transition-transform duration-200"
											style={{
												transform: hasAudioTrack
													? "translateX(0%)"
													: "translateX(-100%)",
											}}
										/>
									</div>
								</>
							) : (
								<MicOff className="text-gray-7 size-5" />
							)}
						</div>

						<ActionButton
							data-no-drag
							onClick={handlePauseToggle}
							disabled={!canTogglePause}
							aria-label={isPaused ? "Resume recording" : "Pause recording"}
						>
							{isPaused ? (
								<PlayCircle className="size-5" />
							) : (
								<PauseCircle className="size-5" />
							)}
						</ActionButton>
						<ActionButton
							data-no-drag
							onClick={handleRestart}
							disabled={!canRestart}
							aria-label="Restart recording"
							aria-busy={isRestarting}
						>
							<RotateCcw
								className={clsx("size-5", isRestarting && "animate-spin")}
							/>
						</ActionButton>
					</div>
				</div>
				<div
					className="cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-5 text-gray-9"
					aria-hidden
				>
					<MoreVertical className="size-5" />
				</div>
			</div>
		</div>,
		document.body,
	);
};

const ActionButton = ({ className, ...props }: ComponentProps<"button">) => (
	<button
		{...props}
		type="button"
		className={clsx(
			"p-[0.25rem] rounded-lg transition-all",
			"text-gray-11",
			"h-8 w-8 flex items-center justify-center",
			"hover:bg-gray-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-9",
			"disabled:opacity-50 disabled:cursor-not-allowed",
			className,
		)}
	/>
);

const InlineChunkProgress = ({
	chunkUploads,
}: {
	chunkUploads: ChunkUploadState[];
}) => {
	if (chunkUploads.length === 0) return null;

	const completedCount = chunkUploads.filter(
		(chunk) => chunk.status === "complete",
	).length;
	const failed = chunkUploads.some((chunk) => chunk.status === "error");
	const uploadingCount = chunkUploads.filter(
		(chunk) => chunk.status === "uploading",
	).length;
	const queuedCount = chunkUploads.filter(
		(chunk) => chunk.status === "queued",
	).length;
	const totalBytes = chunkUploads.reduce(
		(total, chunk) => total + chunk.sizeBytes,
		0,
	);
	const uploadedBytes = chunkUploads.reduce(
		(total, chunk) => total + chunk.uploadedBytes,
		0,
	);
	const progressRatio = Math.max(
		0,
		Math.min(
			1,
			totalBytes > 0
				? uploadedBytes / totalBytes
				: completedCount / chunkUploads.length,
		),
	);
	const radius = 15.9155;
	const circumference = 2 * Math.PI * radius;
	const strokeDashoffset = circumference * (1 - progressRatio);
	const colorClass = failed
		? "text-red-9"
		: completedCount === chunkUploads.length
			? "text-green-9"
			: "text-blue-9";

	const [isPopoverOpen, setIsPopoverOpen] = useState(false);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearHoverTimeout = useCallback(() => {
		if (!hoverTimeoutRef.current) return;
		clearTimeout(hoverTimeoutRef.current);
		hoverTimeoutRef.current = null;
	}, []);

	const openPopover = useCallback(() => {
		clearHoverTimeout();
		setIsPopoverOpen(true);
	}, [clearHoverTimeout]);

	const closePopover = useCallback(() => {
		clearHoverTimeout();
		hoverTimeoutRef.current = setTimeout(() => {
			setIsPopoverOpen(false);
		}, 180);
	}, [clearHoverTimeout]);

	useEffect(() => () => clearHoverTimeout(), [clearHoverTimeout]);

	const statusSummary = [
		{ label: "Uploading", count: uploadingCount, color: "text-blue-11" },
		{ label: "Pending", count: queuedCount, color: "text-amber-11" },
		{ label: "Completed", count: completedCount, color: "text-green-11" },
		{
			label: "Failed",
			count: chunkUploads.filter((chunk) => chunk.status === "error").length,
			color: "text-red-11",
		},
	].filter((item) => item.count > 0);

	const statusLabels: Record<ChunkUploadState["status"], string> = {
		uploading: "Uploading",
		queued: "Pending",
		complete: "Completed",
		error: "Failed",
	};

	const statusAccent: Record<ChunkUploadState["status"], string> = {
		uploading: "text-blue-11",
		queued: "text-amber-11",
		complete: "text-green-11",
		error: "text-red-11",
	};

	return (
		<Popover
			open={isPopoverOpen}
			onOpenChange={(next) => {
				if (!next) {
					clearHoverTimeout();
				}
				setIsPopoverOpen(next);
			}}
		>
			<PopoverTrigger
				asChild
				onMouseEnter={openPopover}
				onMouseLeave={closePopover}
			>
				<button
					type="button"
					data-no-drag
					className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] text-gray-12 transition-colors hover:bg-gray-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-9"
					aria-label="Show upload segments"
					aria-expanded={isPopoverOpen}
				>
					<div
						className="relative h-5 w-5"
						role="img"
						aria-label="Upload progress"
					>
						<svg className="h-5 w-5 -rotate-90" viewBox="0 0 36 36">
							<circle
								className="fill-none stroke-gray-4"
								strokeWidth={4}
								cx="18"
								cy="18"
								r="15.9155"
							/>
							<circle
								className={clsx(
									"fill-none stroke-current transition-[stroke-dashoffset] duration-300 ease-out",
									colorClass,
								)}
								strokeWidth={4}
								strokeLinecap="round"
								strokeDasharray={circumference}
								strokeDashoffset={strokeDashoffset}
								cx="18"
								cy="18"
								r={radius}
							/>
						</svg>
					</div>
					<span
						className={clsx(
							"font-semibold tabular-nums leading-none",
							failed ? "text-red-11" : "text-gray-12",
						)}
					>
						{completedCount}/{chunkUploads.length}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="center"
				className="z-[700] w-72 max-h-[22rem] overflow-hidden border border-gray-5 bg-gray-1 p-4 text-[12px] text-gray-12 shadow-2xl"
				onMouseEnter={openPopover}
				onMouseLeave={closePopover}
			>
				<div className="space-y-3">
					<div className="text-[11px] text-gray-11">
						Uploaded {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)}
					</div>
					<div className="flex flex-wrap gap-2">
						{statusSummary.length === 0 ? (
							<span className="text-[11px] text-gray-11">
								Preparing chunks…
							</span>
						) : (
							statusSummary.map((item) => (
								<span
									key={item.label}
									className={clsx(
										"rounded-full border border-gray-4 bg-gray-2 px-2 py-0.5 text-[10px] font-medium",
										item.color,
									)}
								>
									{item.label}: {item.count}
								</span>
							))
						)}
					</div>
					<div className="max-h-56 space-y-1 overflow-y-auto pr-1">
						{chunkUploads.map((chunk) => (
							<div
								key={chunk.partNumber}
								className="flex flex-col rounded-lg border border-gray-4 bg-gray-2 px-2 py-1"
							>
								<div className="flex items-center justify-between text-[11px]">
									<span className="font-medium text-gray-12">
										Part {chunk.partNumber}
									</span>
									<span
										className={clsx(
											"text-[11px] font-semibold",
											statusAccent[chunk.status],
										)}
									>
										{statusLabels[chunk.status]}
									</span>
								</div>
								<div className="text-[10px] text-gray-11">
									{chunk.status === "uploading"
										? `${Math.round(chunk.progress * 100)}% of ${formatBytes(chunk.sizeBytes)}`
										: chunk.status === "complete"
											? `Uploaded ${formatBytes(chunk.sizeBytes)}`
											: chunk.status === "queued"
												? `Waiting • ${formatBytes(chunk.sizeBytes)}`
												: `Needs attention • ${formatBytes(chunk.sizeBytes)}`}
								</div>
							</div>
						))}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
};

const formatBytes = (bytes: number) => {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** exponent;
	const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(decimals)} ${units[exponent]}`;
};
