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
import type {
	CameraInitState,
	CameraPreviewShape,
	CameraPreviewSize,
	IframeMessage,
	VideoDimensions,
} from "../lib/messages";
import { BAR_HEIGHT, getPreviewMetrics } from "../lib/messages";

type AutoPictureInPictureVideo = HTMLVideoElement & {
	autoPictureInPicture?: boolean;
};

function postToParent(message: Record<string, unknown>) {
	if (window.parent !== window) {
		window.parent.postMessage(message, "*");
	}
}

export const CameraPage = () => {
	const [deviceId, setDeviceId] = useState<string | null>(null);
	const [size, setSize] = useState<CameraPreviewSize>("sm");
	const [shape, setShape] = useState<CameraPreviewShape>("round");
	const [mirrored, setMirrored] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const [lastFrameDataUrl, setLastFrameDataUrl] = useState<string | null>(null);
	const [videoDimensions, setVideoDimensions] =
		useState<VideoDimensions | null>(null);
	const [isInPictureInPicture, setIsInPictureInPicture] = useState(false);
	const autoPictureInPictureRef = useRef(false);
	const dragRef = useRef<{
		pointerId: number;
		lastX: number;
		lastY: number;
	} | null>(null);

	const isPictureInPictureSupported =
		typeof document !== "undefined" && document.pictureInPictureEnabled;

	const canUseAutoPiPAttribute = useMemo(() => {
		if (
			typeof document === "undefined" ||
			typeof HTMLVideoElement === "undefined"
		) {
			return false;
		}

		const doc = document;
		if (!doc.pictureInPictureEnabled) {
			return false;
		}

		const proto = HTMLVideoElement.prototype as unknown as {
			autoPictureInPicture?: boolean;
		};

		return "autoPictureInPicture" in proto;
	}, []);

	useEffect(() => {
		if (!canUseAutoPiPAttribute) return;

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
			if (rafId !== null) cancelAnimationFrame(rafId);
			if (pipVideo) pipVideo.autoPictureInPicture = false;
		};
	}, [canUseAutoPiPAttribute]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const msg = event.data as IframeMessage;

			if (msg.type === "CAMERA_INIT" && msg.state) {
				const s = msg.state as CameraInitState;
				setDeviceId(s.deviceId);
				if (s.size) setSize(s.size);
				if (s.shape) setShape(s.shape);
				if (typeof s.mirrored === "boolean") setMirrored(s.mirrored);
				setLastFrameDataUrl(
					typeof s.lastFrameDataUrl === "string" ? s.lastFrameDataUrl : null,
				);
			}

			if (msg.type === "CAMERA_UPDATE" && msg.state) {
				if (msg.state.deviceId) setDeviceId(msg.state.deviceId);
				if (msg.state.size) setSize(msg.state.size);
				if (msg.state.shape) setShape(msg.state.shape);
				if (typeof msg.state.mirrored === "boolean")
					setMirrored(msg.state.mirrored);
			}

			if (msg.type === "CAMERA_DESTROY") {
				if (streamRef.current) {
					for (const track of streamRef.current.getTracks()) {
						track.stop();
					}
					streamRef.current = null;
				}
			}

			if (msg.type === "CAMERA_ENTER_PIP") {
				const video = videoRef.current;
				if (!video || !isPictureInPictureSupported) return;
				if (document.pictureInPictureElement === video) return;

				video
					.requestPictureInPicture()
					.then(() => {
						autoPictureInPictureRef.current = true;
					})
					.catch(() => {
						autoPictureInPictureRef.current = false;
					});
			}

			if (msg.type === "CAMERA_EXIT_PIP") {
				const video = videoRef.current;
				if (!video || !isPictureInPictureSupported) return;
				if (document.pictureInPictureElement !== video) return;
				if (!autoPictureInPictureRef.current) return;

				document
					.exitPictureInPicture()
					.catch(() => {})
					.finally(() => {
						autoPictureInPictureRef.current = false;
					});
			}
		};

		window.addEventListener("message", handleMessage);
		postToParent({ type: "CAMERA_READY" });

		return () => window.removeEventListener("message", handleMessage);
	}, [isPictureInPictureSupported]);

	useEffect(() => {
		if (!deviceId) return;

		let cancelled = false;
		let fallbackChannel: BroadcastChannel | null = null;
		let fallbackCanvas: HTMLCanvasElement | null = null;
		let fallbackCtx: CanvasRenderingContext2D | null = null;

		const startCamera = async () => {
			if (streamRef.current) {
				for (const track of streamRef.current.getTracks()) {
					track.stop();
				}
				streamRef.current = null;
			}

			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					video: { deviceId: { exact: deviceId } },
				});

				if (cancelled) {
					for (const track of stream.getTracks()) {
						track.stop();
					}
					return;
				}

				streamRef.current = stream;
				if (videoRef.current) {
					videoRef.current.srcObject = stream;
					void videoRef.current.play().catch(() => {});
				}
			} catch {
				if (cancelled) return;
				startFallbackFrameReceiver();
			}
		};

		const startFallbackFrameReceiver = () => {
			fallbackCanvas = document.createElement("canvas");
			fallbackCtx = fallbackCanvas.getContext("2d");
			if (!fallbackCtx) return;

			let streamAttached = false;
			fallbackChannel = new BroadcastChannel("cap-camera-frames");

			fallbackChannel.onmessage = (event: MessageEvent) => {
				if (cancelled || !fallbackCanvas || !fallbackCtx) return;
				const msg = event.data;
				if (msg.type !== "FRAME" || !msg.bitmap) return;

				const bitmap = msg.bitmap as ImageBitmap;
				if (
					fallbackCanvas.width !== bitmap.width ||
					fallbackCanvas.height !== bitmap.height
				) {
					fallbackCanvas.width = bitmap.width;
					fallbackCanvas.height = bitmap.height;
				}
				fallbackCtx.drawImage(bitmap, 0, 0);
				bitmap.close();

				if (!streamAttached && videoRef.current) {
					streamAttached = true;
					const captured = fallbackCanvas.captureStream();
					streamRef.current = captured;
					videoRef.current.srcObject = captured;
					void videoRef.current.play().catch(() => {});
				}
			};

			fallbackChannel.postMessage({ type: "REQUEST_FRAMES" });
		};

		startCamera();

		return () => {
			cancelled = true;
			if (fallbackChannel) {
				fallbackChannel.postMessage({ type: "STOP_FRAMES" });
				fallbackChannel.close();
				fallbackChannel = null;
			}
			fallbackCanvas = null;
			fallbackCtx = null;
			if (streamRef.current) {
				for (const track of streamRef.current.getTracks()) {
					track.stop();
				}
				streamRef.current = null;
			}
		};
	}, [deviceId]);

	useEffect(() => {
		const metrics = getPreviewMetrics(size, shape, videoDimensions);
		const totalHeight = metrics.height + BAR_HEIGHT;
		postToParent({
			type: "CAMERA_RESIZE",
			width: metrics.width,
			height: totalHeight,
		});
	}, [size, shape, videoDimensions]);

	useEffect(() => {
		if (videoDimensions) {
			setLastFrameDataUrl(null);
			postToParent({ type: "CAMERA_FEED_READY" });
		}
	}, [videoDimensions]);

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

		if (streamRef.current) {
			for (const track of streamRef.current.getTracks()) {
				track.stop();
			}
			streamRef.current = null;
		}

		postToParent({ type: "CAMERA_CLOSED" });
	}, []);

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

		const handlePipEnter = () => setIsInPictureInPicture(true);
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
		if (typeof document === "undefined") return;
		if (!isPictureInPictureSupported) return;

		const handleVisibilityChange = () => {
			const video = videoRef.current;
			if (!video || !videoDimensions) return;

			const currentElement = document.pictureInPictureElement;

			if (
				currentElement &&
				currentElement !== video &&
				document.visibilityState === "hidden"
			) {
				return;
			}

			if (document.visibilityState === "hidden") {
				if (currentElement === video) return;

				video
					.requestPictureInPicture()
					.then(() => {
						autoPictureInPictureRef.current = true;
					})
					.catch(() => {
						autoPictureInPictureRef.current = false;
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
					.catch(() => {})
					.finally(() => {
						autoPictureInPictureRef.current = false;
					});
				return;
			}

			autoPictureInPictureRef.current = false;
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [videoDimensions, isPictureInPictureSupported]);

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

	if (!deviceId) {
		return null;
	}

	const metrics = getPreviewMetrics(size, shape, videoDimensions);
	const videoStyle = videoDimensions
		? {
				transform: mirrored ? "scaleX(-1)" : "scaleX(1)",
				opacity: isInPictureInPicture ? 0 : 1,
			}
		: { opacity: 0 };

	const borderRadius =
		shape === "round" ? "9999px" : size === "sm" ? "3rem" : "4rem";

	return (
		<div
			className="group w-full cursor-grab active:cursor-grabbing"
			style={{ width: `${metrics.width}px` }}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				const target = event.target as HTMLElement;
				if (target.closest("[data-controls]")) return;
				if (target.closest("[data-no-drag]")) return;
				dragRef.current = {
					pointerId: event.pointerId,
					lastX: event.clientX,
					lastY: event.clientY,
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				const current = dragRef.current;
				if (!current || current.pointerId !== event.pointerId) return;
				event.preventDefault();
				const deltaX = event.clientX - current.lastX;
				const deltaY = event.clientY - current.lastY;
				current.lastX = event.clientX;
				current.lastY = event.clientY;
				postToParent({ type: "CAMERA_DRAG_DELTA", deltaX, deltaY });
			}}
			onPointerUp={(event) => {
				const current = dragRef.current;
				if (!current || current.pointerId !== event.pointerId) return;
				dragRef.current = null;
				postToParent({ type: "CAMERA_DRAG_END" });
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={(event) => {
				const current = dragRef.current;
				if (!current || current.pointerId !== event.pointerId) return;
				dragRef.current = null;
				postToParent({ type: "CAMERA_DRAG_END" });
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
		>
			<div className="flex relative flex-col w-full" style={{ borderRadius }}>
				<div className="h-13">
					<div className="flex flex-row justify-center items-center">
						<div
							data-controls
							className="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10 pointer-events-auto"
							role="toolbar"
							aria-label="Camera preview controls"
						>
							<button
								type="button"
								onClick={handleClose}
								className="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12"
								data-no-drag
							>
								<X className="size-5.5" />
							</button>
							<button
								type="button"
								onClick={() =>
									setSize((s) => {
										const next = s === "sm" ? "lg" : "sm";
										postToParent({
											type: "CAMERA_STATE_CHANGED",
											state: { size: next },
										});
										return next;
									})
								}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									size === "lg" && "bg-gray-3 text-gray-12",
								)}
								data-no-drag
							>
								<Maximize2 className="size-5.5" />
							</button>
							<button
								type="button"
								onClick={() =>
									setShape((s) => {
										const next =
											s === "round"
												? "square"
												: s === "square"
													? "full"
													: "round";
										postToParent({
											type: "CAMERA_STATE_CHANGED",
											state: { shape: next },
										});
										return next;
									})
								}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									shape !== "round" && "bg-gray-3 text-gray-12",
								)}
								data-no-drag
							>
								{shape === "round" && <Circle className="size-5.5" />}
								{shape === "square" && <Square className="size-5.5" />}
								{shape === "full" && (
									<RectangleHorizontal className="size-5.5" />
								)}
							</button>
							<button
								type="button"
								onClick={() =>
									setMirrored((m) => {
										const next = !m;
										postToParent({
											type: "CAMERA_STATE_CHANGED",
											state: { mirrored: next },
										});
										return next;
									})
								}
								className={clsx(
									"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
									mirrored && "bg-gray-3 text-gray-12",
								)}
								data-no-drag
							>
								<FlipHorizontal className="size-5.5" />
							</button>
							{isPictureInPictureSupported && (
								<button
									type="button"
									onClick={handleTogglePictureInPicture}
									className={clsx(
										"p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
										isInPictureInPicture && "bg-gray-3 text-gray-12",
									)}
									data-no-drag
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
					{!videoDimensions && lastFrameDataUrl && (
						<img
							src={lastFrameDataUrl}
							alt=""
							aria-hidden
							className={clsx(
								"absolute inset-0 w-full h-full object-cover",
								shape === "round" ? "rounded-full" : "rounded-3xl",
							)}
						/>
					)}
					<video
						ref={videoRef}
						autoPlay
						playsInline
						muted
						disablePictureInPicture={false}
						controlsList="nodownload nofullscreen noremoteplayback"
						className={clsx(
							"absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-200",
							shape === "round" ? "rounded-full" : "rounded-3xl",
						)}
						style={videoStyle}
						onLoadedMetadata={() => {
							if (videoRef.current) {
								const width = videoRef.current.videoWidth;
								const height = videoRef.current.videoHeight;
								if (width > 0 && height > 0) {
									setVideoDimensions({ width, height });
								}
							}
						}}
					/>
					{!videoDimensions && !lastFrameDataUrl && (
						<div className="absolute inset-0 flex items-center justify-center">
							<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
						</div>
					)}
					{isPictureInPictureSupported && isInPictureInPicture && (
						<div className="absolute inset-0 flex items-center justify-center z-10">
							<div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-2 text-xs font-medium text-white/90 shadow-sm backdrop-blur-md whitespace-nowrap transition-all duration-300 ease-out">
								<span>Picture in Picture active</span>
								<button
									type="button"
									onClick={handleTogglePictureInPicture}
									className="flex items-center justify-center size-4 rounded-full hover:bg-white/20 transition-colors"
									aria-label="Exit Picture in Picture"
									data-no-drag
								>
									<X className="size-3" />
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
