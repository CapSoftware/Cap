"use client";

import { LoadingSpinner } from "@cap/ui";
import clsx from "clsx";
import {
	Circle,
	FlipHorizontal,
	Maximize2,
	PictureInPicture,
	RectangleHorizontal,
	Square,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type CameraPreviewSize = "sm" | "lg";
type CameraPreviewShape = "round" | "square" | "full";
type VideoDimensions = {
	width: number;
	height: number;
};
type AutoPictureInPictureDocument = Document & {
	autoPictureInPictureEnabled?: boolean;
};
type AutoPictureInPictureVideo = HTMLVideoElement & {
	autoPictureInPicture?: boolean;
};

const WINDOW_PADDING = 20;
const BAR_HEIGHT = 52;

const getPreviewMetrics = (
	previewSize: CameraPreviewSize,
	previewShape: CameraPreviewShape,
	dimensions: VideoDimensions | null,
) => {
	const base = previewSize === "sm" ? 230 : 400;

	if (!dimensions || dimensions.height === 0) {
		return {
			base,
			width: base,
			height: base,
			aspectRatio: 1,
		};
	}

	const aspectRatio = dimensions.width / dimensions.height;

	if (previewShape !== "full") {
		return {
			base,
			width: base,
			height: base,
			aspectRatio,
		};
	}

	if (aspectRatio >= 1) {
		return {
			base,
			width: base * aspectRatio,
			height: base,
			aspectRatio,
		};
	}

	return {
		base,
		width: base,
		height: base / aspectRatio,
		aspectRatio,
	};
};

interface CameraPreviewWindowProps {
	cameraId: string;
	onClose: () => void;
}

export const CameraPreviewWindow = ({
	cameraId,
	onClose,
}: CameraPreviewWindowProps) => {
	const [size, setSize] = useState<CameraPreviewSize>("sm");
	const [shape, setShape] = useState<CameraPreviewShape>("round");
	const [mirrored, setMirrored] = useState(false);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [videoDimensions, setVideoDimensions] =
		useState<VideoDimensions | null>(null);
	const [mounted, setMounted] = useState(false);
	const [isInPictureInPicture, setIsInPictureInPicture] = useState(false);
	const autoPictureInPictureRef = useRef(false);
	const isPictureInPictureSupported =
		typeof document !== "undefined" && document.pictureInPictureEnabled;
	const canUseAutoPiPAttribute = useMemo(() => {
		if (
			typeof document === "undefined" ||
			typeof HTMLVideoElement === "undefined"
		) {
			return false;
		}

		const doc = document as AutoPictureInPictureDocument;
		const autoPiPAllowed =
			typeof doc.autoPictureInPictureEnabled === "boolean"
				? doc.autoPictureInPictureEnabled
				: true;

		if (!doc.pictureInPictureEnabled || !autoPiPAllowed) {
			return false;
		}

		const proto = HTMLVideoElement.prototype as unknown as {
			autoPictureInPicture?: boolean;
		};

		return "autoPictureInPicture" in proto;
	}, []);

	useEffect(() => {
		if (!canUseAutoPiPAttribute) {
			return;
		}

		let rafId: number | null = null;
		let pipVideo: AutoPictureInPictureVideo | null = null;
		let disposed = false;

		const attachAttribute = () => {
			if (disposed) return;

			const maybeVideo = videoRef.current as AutoPictureInPictureVideo | null;
			if (!maybeVideo) {
				rafId = requestAnimationFrame(attachAttribute);
				return;
			}

			pipVideo = maybeVideo;
			pipVideo.autoPictureInPicture = true;
		};

		attachAttribute();

		return () => {
			disposed = true;
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			if (pipVideo) {
				pipVideo.autoPictureInPicture = false;
			}
		};
	}, [canUseAutoPiPAttribute]);

	useEffect(() => {
		setMounted(true);
		return () => {
			setMounted(false);
		};
	}, []);

	useEffect(() => {
		const startCamera = async () => {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					video: {
						deviceId: { exact: cameraId },
					},
				});

				streamRef.current = stream;

				if (videoRef.current) {
					videoRef.current.srcObject = stream;
				}
			} catch (err) {
				console.error("Failed to start camera", err);
			}
		};

		startCamera();

		return () => {
			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => {
					track.stop();
				});
				streamRef.current = null;
			}
		};
	}, [cameraId]);

	useEffect(() => {
		const metrics = getPreviewMetrics(size, shape, videoDimensions);

		if (typeof window === "undefined") {
			return;
		}

		const totalHeight = metrics.height + BAR_HEIGHT;
		const maxX = Math.max(0, window.innerWidth - metrics.width);
		const maxY = Math.max(0, window.innerHeight - totalHeight);

		setPosition((prev) => {
			const defaultX = window.innerWidth - metrics.width - WINDOW_PADDING;
			const defaultY = window.innerHeight - totalHeight - WINDOW_PADDING;
			const nextX = prev?.x ?? defaultX;
			const nextY = prev?.y ?? defaultY;

			return {
				x: Math.max(0, Math.min(nextX, maxX)),
				y: Math.max(0, Math.min(nextY, maxY)),
			};
		});
	}, [size, shape, videoDimensions]);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if ((e.target as HTMLElement).closest("[data-controls]")) {
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			setIsDragging(true);
			setDragStart({
				x: e.clientX - (position?.x || 0),
				y: e.clientY - (position?.y || 0),
			});
		},
		[position],
	);

	const handleMouseMove = useCallback(
		(e: MouseEvent) => {
			if (!isDragging) return;

			const newX = e.clientX - dragStart.x;
			const newY = e.clientY - dragStart.y;

			const metrics = getPreviewMetrics(size, shape, videoDimensions);
			const totalHeight = metrics.height + BAR_HEIGHT;
			const maxX = Math.max(0, window.innerWidth - metrics.width);
			const maxY = Math.max(0, window.innerHeight - totalHeight);

			setPosition({
				x: Math.max(0, Math.min(newX, maxX)),
				y: Math.max(0, Math.min(newY, maxY)),
			});
		},
		[isDragging, dragStart, size, shape, videoDimensions],
	);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
	}, []);

	useEffect(() => {
		if (isDragging) {
			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
			return () => {
				window.removeEventListener("mousemove", handleMouseMove);
				window.removeEventListener("mouseup", handleMouseUp);
			};
		}
	}, [isDragging, handleMouseMove, handleMouseUp]);

	const handleClose = useCallback(async () => {
		if (
			videoRef.current &&
			document.pictureInPictureElement === videoRef.current
		) {
			try {
				autoPictureInPictureRef.current = false;
				await document.exitPictureInPicture();
			} catch (err) {
				console.error("Failed to exit Picture-in-Picture", err);
			}
		}
		onClose();
	}, [onClose]);

	const handleTogglePictureInPicture = useCallback(async () => {
		const video = videoRef.current;
		if (!video || !isPictureInPictureSupported) return;

		try {
			autoPictureInPictureRef.current = false;
			if (document.pictureInPictureElement === video) {
				await document.exitPictureInPicture();
			} else {
				await video.requestPictureInPicture();
			}
		} catch (err) {
			console.error("Failed to toggle Picture-in-Picture", err);
		}
	}, [isPictureInPictureSupported]);

	useEffect(() => {
		if (!videoRef.current || !videoDimensions || !isPictureInPictureSupported)
			return;

		const video = videoRef.current;

		const handlePipEnter = () => {
			setIsInPictureInPicture(true);
		};

		const handlePipLeave = () => {
			autoPictureInPictureRef.current = false;
			setIsInPictureInPicture(false);
		};

		video.addEventListener("enterpictureinpicture", handlePipEnter);
		video.addEventListener("leavepictureinpicture", handlePipLeave);

		if (document.pictureInPictureElement === video) {
			setIsInPictureInPicture(true);
		}

		return () => {
			video.removeEventListener("enterpictureinpicture", handlePipEnter);
			video.removeEventListener("leavepictureinpicture", handlePipLeave);
		};
	}, [videoDimensions, isPictureInPictureSupported]);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}

		if (!isPictureInPictureSupported || canUseAutoPiPAttribute) {
			return;
		}

		const handleVisibilityChange = () => {
			const video = videoRef.current;

			if (!video || !videoDimensions) {
				return;
			}

			const currentElement = document.pictureInPictureElement;
			const hasActiveUserGesture =
				typeof navigator !== "undefined" && navigator.userActivation?.isActive;

			if (
				currentElement &&
				currentElement !== video &&
				document.visibilityState === "hidden"
			) {
				return;
			}

			if (document.visibilityState === "hidden") {
				if (currentElement === video) {
					return;
				}

				if (!hasActiveUserGesture) {
					return;
				}

				video
					.requestPictureInPicture()
					.then(() => {
						autoPictureInPictureRef.current = true;
					})
					.catch((err) => {
						autoPictureInPictureRef.current = false;
						console.error(
							"Failed to enter Picture-in-Picture on tab change",
							err,
						);
					});

				return;
			}

			if (
				autoPictureInPictureRef.current &&
				currentElement === video &&
				document.visibilityState === "visible"
			) {
				document
					.exitPictureInPicture()
					.catch((err) => {
						console.error(
							"Failed to exit Picture-in-Picture after returning",
							err,
						);
					})
					.finally(() => {
						autoPictureInPictureRef.current = false;
					});
				return;
			}

			autoPictureInPictureRef.current = false;
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [videoDimensions, isPictureInPictureSupported, canUseAutoPiPAttribute]);

	useEffect(() => {
		return () => {
			if (
				typeof document !== "undefined" &&
				videoRef.current &&
				document.pictureInPictureElement === videoRef.current
			) {
				document.exitPictureInPicture().catch((err) => {
					console.error("Failed to exit Picture-in-Picture on cleanup", err);
				});
			}
		};
	}, []);

	if (!mounted || !position) {
		return null;
	}

	const metrics = getPreviewMetrics(size, shape, videoDimensions);
	const totalHeight = metrics.height + BAR_HEIGHT;
	const videoStyle = videoDimensions
		? {
				transform: mirrored ? "scaleX(-1)" : "scaleX(1)",
				opacity: isInPictureInPicture ? 0 : 1,
			}
		: { opacity: 0 };

	const borderRadius =
		shape === "round" ? "9999px" : size === "sm" ? "3rem" : "4rem";

	return createPortal(
		<div
			ref={containerRef}
			data-camera-preview
			className="fixed z-[600] group cursor-move pointer-events-auto"
			role="dialog"
			style={{
				left: `${position.x}px`,
				top: `${position.y}px`,
				width: `${metrics.width}px`,
				height: `${totalHeight}px`,
				borderRadius,
			}}
			onMouseDown={(e) => {
				e.stopPropagation();
				e.preventDefault();
				handleMouseDown(e);
			}}
		>
			<div
				className="flex relative flex-col w-full h-full cursor-move"
				style={{ borderRadius }}
			>
				<div className="h-13">
					<div className="flex flex-row justify-center items-center">
						<div
							data-controls
							className="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10 pointer-events-auto"
							role="toolbar"
							aria-label="Camera preview controls"
							onMouseDown={(e) => e.stopPropagation()}
							onClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									handleClose();
								}
							}}
						>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									handleClose();
								}}
								className="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12"
							>
								<X className="size-5.5" />
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setSize((s) => (s === "sm" ? "lg" : "sm"));
								}}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									size === "lg" && "bg-gray-3 text-gray-12",
								)}
							>
								<Maximize2 className="size-5.5" />
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setShape((s) =>
										s === "round"
											? "square"
											: s === "square"
												? "full"
												: "round",
									);
								}}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									shape !== "round" && "bg-gray-3 text-gray-12",
								)}
							>
								{shape === "round" && <Circle className="size-5.5" />}
								{shape === "square" && <Square className="size-5.5" />}
								{shape === "full" && (
									<RectangleHorizontal className="size-5.5" />
								)}
							</button>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setMirrored((m) => !m);
								}}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									mirrored && "bg-gray-3 text-gray-12",
								)}
							>
								<FlipHorizontal className="size-5.5" />
							</button>
							{isPictureInPictureSupported && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										handleTogglePictureInPicture();
									}}
									className={clsx(
										"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
										isInPictureInPicture && "bg-gray-3 text-gray-12",
									)}
								>
									<PictureInPicture className="size-5.5" />
								</button>
							)}
						</div>
					</div>
				</div>

				<div
					className={clsx(
						"relative overflow-hidden border-none shadow-lg bg-black text-gray-12",
						shape === "round" ? "rounded-full" : "rounded-3xl",
					)}
					style={{
						width: `${metrics.width}px`,
						height: `${metrics.height}px`,
					}}
				>
					<video
						ref={videoRef}
						autoPlay
						playsInline
						muted
						disablePictureInPicture={false}
						controlsList="nodownload nofullscreen noremoteplayback"
						className={clsx(
							"absolute inset-0 w-full h-full object-cover pointer-events-none",
							shape === "round" ? "rounded-full" : "rounded-3xl",
						)}
						style={videoStyle}
						onLoadedMetadata={() => {
							if (videoRef.current) {
								const width = videoRef.current.videoWidth;
								const height = videoRef.current.videoHeight;

								if (width > 0 && height > 0) {
									setVideoDimensions({
										width,
										height,
									});
								}
							}
						}}
					/>
					{!videoDimensions && (
						<div className="absolute inset-0 flex items-center justify-center">
							<LoadingSpinner size={32} themeColors />
						</div>
					)}
					{isPictureInPictureSupported && isInPictureInPicture && (
						<div className="absolute inset-0 flex items-center justify-center z-10">
							<div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-2 text-xs font-medium text-white/90 shadow-sm backdrop-blur-md whitespace-nowrap transition-all duration-300 ease-out">
								<span>Picture in Picture active</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										handleTogglePictureInPicture();
									}}
									className="flex items-center justify-center size-4 rounded-full hover:bg-white/20 transition-colors"
									aria-label="Exit Picture in Picture"
								>
									<X className="size-3" />
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
};
